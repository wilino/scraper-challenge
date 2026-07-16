import { createHash, randomUUID } from "node:crypto";

import { DownloadManifestStore } from "./download-manifest-store.js";
import { CorpusMembershipStore } from "./corpus-membership-store.js";
import { FailureStore } from "./failure-store.js";
import { HttpRequestError } from "./http-errors.js";
import {
  DiscoveryConfigurationError,
  DiscoverySessionStateError,
  DiscoveryStopError,
  type DiscoveryPage,
  type DiscoveryRecord,
  type DiscoveryRunOptions,
  type DiscoverySource,
  type DiscoverySummary,
  type PartitionDiscoverySummary,
  type SuccessfulTermination,
} from "./discovery-types.js";
import { PagePersistence } from "./page-persistence.js";
import { checkpointSchema, type Checkpoint } from "../models/checkpoint.js";
import { downloadManifestEventSchema } from "../models/download-manifest.js";
import { scrapedDocumentSchema, type ScrapedDocument } from "../models/document.js";
import type { CorpusIdentity } from "../models/corpus-membership.js";
import type { ScrapeFailure } from "../models/failure.js";

export interface DiscoveryOrchestratorOptions<TRecord extends DiscoveryRecord = DiscoveryRecord> {
  source: DiscoverySource<TRecord>;
  outputDirectory: string;
  baseUrl: string;
  queryHash: string;
  partitions: readonly string[];
  corpusReconciliationPassed?: boolean;
  passNumber?: number;
  membershipStore?: CorpusMembershipStore;
  now?: () => Date;
  uuid?: () => string;
}

interface MutablePartitionSummary {
  partitionId: string;
  publishedGlobalTotal: number | null;
  initialQueryTotal: number;
  finalQueryTotal: number;
  queryTotal: number;
  initialMaxPages: number;
  finalMaxPages: number;
  maxPages: number;
  drift: boolean;
  pagesVisited: number;
  rawMemberships: number;
  uniqueMemberships: number;
  duplicateMemberships: number;
  newDocuments: number;
  newCorpusMemberships: number;
  globalDuplicates: number;
  detailFailures: number;
  termination?: SuccessfulTermination;
}

interface StoredDocumentIdentity {
  documentId: string;
  pdfUuid?: string;
}

export class DiscoveryOrchestrator<TRecord extends DiscoveryRecord = DiscoveryRecord> {
  readonly #source: DiscoverySource<TRecord>;
  readonly #persistence: PagePersistence;
  readonly #manifest: DownloadManifestStore;
  readonly #failures: FailureStore;
  readonly #baseUrl: string;
  readonly #queryHash: string;
  readonly #partitions: readonly string[];
  readonly #corpusReconciliationPassed: boolean;
  readonly #passNumber: number;
  readonly #memberships: CorpusMembershipStore;
  readonly #now: () => Date;
  readonly #uuid: () => string;

  public constructor(options: DiscoveryOrchestratorOptions<TRecord>) {
    if (
      options.partitions.length === 0 ||
      new Set(options.partitions).size !== options.partitions.length
    )
      throw new Error("Las particiones de descubrimiento deben ser únicas y no vacías");
    this.#source = options.source;
    this.#persistence = new PagePersistence(options.outputDirectory);
    this.#manifest = new DownloadManifestStore(
      `${options.outputDirectory}/data/download-manifest.jsonl`,
    );
    this.#failures = new FailureStore(`${options.outputDirectory}/data/failures.jsonl`);
    this.#baseUrl = new URL(options.baseUrl).href;
    this.#queryHash = options.queryHash;
    this.#partitions = [...options.partitions];
    this.#corpusReconciliationPassed = options.corpusReconciliationPassed ?? false;
    this.#passNumber = options.passNumber ?? 1;
    if (!Number.isInteger(this.#passNumber) || this.#passNumber < 1) {
      throw new Error("El número de pasada debe ser un entero positivo");
    }
    this.#memberships =
      options.membershipStore ??
      new CorpusMembershipStore(`${options.outputDirectory}/data/corpus-memberships.jsonl`);
    this.#now = options.now ?? (() => new Date());
    this.#uuid = options.uuid ?? randomUUID;
    checkpointSchema.shape.queryHash.parse(options.queryHash);
  }

  public async run(options: DiscoveryRunOptions = {}): Promise<DiscoverySummary> {
    validateLimit(options.limit, "limit");
    validateLimit(options.maxPages, "maxPages");
    throwIfAborted(options.signal);
    const manifestDocumentIds = await this.#manifest.documentIds(options.signal);
    const documentsByIdentity = new Map<string, StoredDocumentIdentity>();
    await this.#persistence.scanDocuments(async (document) => {
      indexDocumentIdentities(documentsByIdentity, compactDocumentIdentity(document));
      await this.#ensureManifest(document, manifestDocumentIds);
    }, options.signal);
    await this.#memberships.initialize(options.signal);
    await this.#failures.initialize(options.signal);
    const checkpoint = options.resume === true ? await this.#compatibleCheckpoint() : null;
    await this.#source.preflight(options.signal);

    const summaries: MutablePartitionSummary[] = [];
    let totalPages = 0;
    let totalNewDocuments = 0;
    let runTermination: SuccessfulTermination = "natural_end";
    const resumePartitionIndex =
      checkpoint === null ? 0 : this.#partitions.indexOf(checkpoint.partitionId);

    for (
      let partitionIndex = resumePartitionIndex;
      partitionIndex < this.#partitions.length;
      partitionIndex += 1
    ) {
      const partitionId = this.#partitions[partitionIndex];
      if (partitionId === undefined) break;
      const resumesHere = checkpoint?.partitionId === partitionId;
      const resumePage = resumesHere ? checkpoint.page : 1;
      const resumeRow = resumesHere ? checkpoint.confirmedRow : 0;
      const fullPartitionObservation = resumePage === 1 && resumeRow === 0;
      let page = await this.#source.openPartition(partitionId, resumePage, options.signal);
      assertPartition(page, partitionId);
      const summary = newPartitionSummary(partitionId, page);
      summaries.push(summary);
      const fingerprints = new Set<string>();
      const partitionIds = new Set<string>();
      let firstPage = true;

      for (;;) {
        throwIfAborted(options.signal);
        assertPartition(page, partitionId);
        const fingerprint = fingerprintFor(page);
        if (fingerprints.has(fingerprint)) {
          throw stop("repeated_fingerprint", "PJ repitió una página sin progreso", page, {
            fingerprint,
          });
        }
        fingerprints.add(fingerprint);
        totalPages += 1;
        summary.pagesVisited += 1;
        summary.rawMemberships += page.parsed.records.length;
        updateObservedTotals(summary, page);

        let newPartitionMemberships = 0;
        const startRow = firstPage ? resumeRow : 0;
        if (startRow > page.parsed.records.length) {
          throw stop("reconciliation_mismatch", "Checkpoint excede las filas de la página", page, {
            confirmedRow: startRow,
            rows: page.parsed.records.length,
          });
        }

        for (const record of page.parsed.records) {
          const firstInPartition = !partitionIds.has(record.nativeId);
          if (firstInPartition) {
            partitionIds.add(record.nativeId);
            newPartitionMemberships += 1;
            summary.uniqueMemberships += 1;
          } else {
            summary.duplicateMemberships += 1;
          }
        }

        for (const [row, record] of page.parsed.records.entries()) {
          if (row < startRow) {
            summary.globalDuplicates += 1;
            continue;
          }
          if (options.limit !== undefined && totalNewDocuments >= options.limit) {
            summary.termination = "limit";
            runTermination = "limit";
            return finalSummary(summaries, runTermination, false);
          }
          const storedDocument = documentsByIdentity.get(record.nativeId);
          if (storedDocument !== undefined) {
            const membership = await this.#recordMembership(partitionId, record, storedDocument);
            if (membership) summary.newCorpusMemberships += 1;
            summary.globalDuplicates += 1;
            await this.#failures.resolveOpenForDocument(
              "detail",
              storedDocument.documentId,
              this.#now().toISOString(),
              options.signal,
            );
            if (record.nativeId !== storedDocument.documentId) {
              await this.#failures.resolveOpenForDocument(
                "detail",
                record.nativeId,
                this.#now().toISOString(),
                options.signal,
              );
            }
            await this.#persistence.confirmCheckpoint(
              this.#checkpoint(partitionId, page.parsed.pagination.currentPage, row + 1),
            );
            continue;
          }

          let document: ScrapedDocument;
          try {
            document = await this.#source.enrichRecord(record, {
              partitionId,
              page: page.parsed.pagination.currentPage,
              row,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
          } catch (error: unknown) {
            if (isInterruption(error, options.signal)) throw error;
            if (error instanceof DiscoverySessionStateError) throw error;
            await this.#recordDetailFailure(
              record.nativeId,
              partitionId,
              page,
              error,
              options.signal,
            );
            const membership = await this.#recordMembership(partitionId, record);
            if (membership) summary.newCorpusMemberships += 1;
            summary.detailFailures += 1;
            await this.#persistence.confirmCheckpoint(
              this.#checkpoint(partitionId, page.parsed.pagination.currentPage, row + 1),
            );
            continue;
          }
          validateDocument(document, record, page, row);
          const compactDocument = compactDocumentIdentity(document);
          await this.#ensureManifest(document, manifestDocumentIds);
          const inserted = await this.#persistence.persistDocuments([document]);
          if (inserted === 1) {
            indexDocumentIdentities(documentsByIdentity, compactDocument);
            summary.newDocuments += 1;
            totalNewDocuments += 1;
          } else {
            summary.globalDuplicates += 1;
          }
          await this.#failures.resolveOpenForDocument(
            "detail",
            document.documentId,
            this.#now().toISOString(),
            options.signal,
          );
          if (record.nativeId !== document.documentId) {
            await this.#failures.resolveOpenForDocument(
              "detail",
              record.nativeId,
              this.#now().toISOString(),
              options.signal,
            );
          }
          const membership = await this.#recordMembership(partitionId, record, compactDocument);
          if (membership) summary.newCorpusMemberships += 1;
          await this.#persistence.confirmCheckpoint(
            this.#checkpoint(partitionId, page.parsed.pagination.currentPage, row + 1),
          );
        }
        firstPage = false;

        if (page.parsed.pagination.endSignal === "natural_end") {
          if (fullPartitionObservation) validateNaturalEnd(summary, page);
          summary.termination = "natural_end";
          break;
        }
        if (newPartitionMemberships === 0) {
          throw stop("no_progress", "Página PJ sin membresías nuevas ni señal de fin", page, {
            ids: page.parsed.records.map(({ nativeId }) => nativeId),
            fingerprint,
          });
        }
        if (options.maxPages !== undefined && totalPages >= options.maxPages) {
          summary.termination = "max_pages";
          runTermination = "max_pages";
          return finalSummary(summaries, runTermination, false);
        }
        const next = await this.#source.nextPage(page, options.signal);
        if (next === null) {
          throw stop(
            "reconciliation_mismatch",
            "Adaptador terminó sin fin estructural PJ",
            page,
            {},
          );
        }
        page = next;
      }
    }

    return finalSummary(
      summaries,
      runTermination,
      this.#corpusReconciliationPassed && summaries.length === this.#partitions.length,
    );
  }

  async #compatibleCheckpoint(): Promise<Checkpoint | null> {
    const checkpoint = await this.#persistence.loadCheckpoint();
    if (checkpoint === null) return null;
    if (
      checkpoint.baseUrl !== this.#baseUrl ||
      checkpoint.queryHash !== this.#queryHash ||
      !this.#partitions.includes(checkpoint.partitionId)
    ) {
      throw new DiscoveryConfigurationError(
        "Checkpoint incompatible con URL, consulta o particiones actuales",
      );
    }
    return checkpoint;
  }

  #checkpoint(partitionId: string, page: number, confirmedRow: number): Checkpoint {
    return {
      schemaVersion: 1,
      source: "pj",
      baseUrl: this.#baseUrl,
      queryHash: this.#queryHash,
      partitionId,
      page,
      confirmedRow,
      updatedAt: this.#now().toISOString(),
    };
  }

  async #ensureManifest(document: ScrapedDocument, documentIds: Set<string>): Promise<void> {
    if (documentIds.has(document.documentId)) return;
    const base = {
      schemaVersion: 1 as const,
      eventId: this.#uuid(),
      documentId: document.documentId,
      occurredAt: this.#now().toISOString(),
    };
    const event = downloadManifestEventSchema.parse(
      document.pdf.state === "pending"
        ? { ...base, state: "pending", request: document.pdf.request }
        : { ...base, state: "no_pdf", reason: document.pdf.reason },
    );
    await this.#manifest.append(event);
    documentIds.add(document.documentId);
  }

  async #recordMembership(
    partitionId: string,
    record: TRecord,
    knownDocument?: StoredDocumentIdentity,
  ): Promise<boolean> {
    const sourceIdentity = this.#source.membershipIdentity?.(record) ?? {
      documentUuid: record.nativeId,
    };
    const membership = await this.#memberships.record({
      schemaVersion: 1,
      type: "membership",
      partitionId,
      pass: this.#passNumber,
      membershipToken: record.nativeId,
      identity:
        knownDocument === undefined
          ? sourceIdentity
          : mergeCorpusIdentity(sourceIdentity, knownDocument),
      observedAt: this.#now().toISOString(),
    });
    return membership.newForPartition;
  }

  async #recordDetailFailure(
    documentId: string,
    partitionId: string,
    page: DiscoveryPage,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    const classification = classifyDetailFailure(error);
    const httpError = error instanceof HttpRequestError ? error : undefined;
    const failure: ScrapeFailure = {
      schemaVersion: 1,
      failureId: this.#uuid(),
      phase: "detail",
      partitionId,
      documentId,
      page: page.parsed.pagination.currentPage,
      classification,
      attempts: httpError?.attempt ?? 1,
      retryable:
        httpError?.retryable ?? (classification === "network" || classification === "timeout"),
      message: `Detalle PJ incompleto (${errorName(error)})`,
      ...(httpError?.status === undefined ? {} : { status: httpError.status }),
      ...(httpError?.code === undefined ? {} : { code: httpError.code }),
      ...(httpError?.retryAfterMs === undefined
        ? {}
        : {
            retryAfterMs: httpError.retryAfterMs,
            nextRetryAt: new Date(this.#now().getTime() + httpError.retryAfterMs).toISOString(),
          }),
      resolution: "open",
      occurredAt: this.#now().toISOString(),
    };
    await this.#failures.upsertOpenForDocument(failure, signal);
  }
}

function validateLimit(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1))
    throw new Error(`${name} debe ser un entero positivo`);
}

function mergeCorpusIdentity(
  source: CorpusIdentity,
  document: StoredDocumentIdentity,
): CorpusIdentity {
  return document.pdfUuid === undefined ? source : { ...source, pdfUuid: document.pdfUuid };
}

function pdfUuidFromDocument(document: ScrapedDocument): string | undefined {
  if (document.pdf.state !== "pending") return undefined;
  const pdfUuid = new URL(document.pdf.request.url).searchParams.get("uuid")?.toLowerCase();
  return pdfUuid !== undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(pdfUuid)
    ? pdfUuid
    : undefined;
}

function indexDocumentIdentities(
  index: Map<string, StoredDocumentIdentity>,
  document: StoredDocumentIdentity,
): void {
  for (const identity of [document.documentId, document.pdfUuid]) {
    if (identity === undefined) continue;
    const previous = index.get(identity);
    if (previous !== undefined && previous.documentId !== document.documentId) {
      throw new DiscoveryConfigurationError("Dos documentos persistidos comparten identidad PDF");
    }
    index.set(identity, document);
  }
}

function compactDocumentIdentity(document: ScrapedDocument): StoredDocumentIdentity {
  const pdfUuid = pdfUuidFromDocument(document);
  return {
    documentId: document.documentId,
    ...(pdfUuid === undefined ? {} : { pdfUuid }),
  };
}

function classifyDetailFailure(error: unknown): ScrapeFailure["classification"] {
  if (error instanceof HttpRequestError) {
    if (error.classification === "rate_limit") return "rate_limit";
    if (error.classification === "http_permanent") return "http_permanent";
    if (error.classification === "timeout") return "timeout";
    if (error.classification === "security") return "security";
    if (error.classification === "access") return "access";
    if (error.classification === "structural") return "structural";
    if (error.classification === "invalid_content") return "invalid_content";
    if (error.classification === "interrupted") return "interrupted";
    return "network";
  }
  if (error instanceof DiscoveryStopError && error.reason === "interrupted") return "interrupted";
  if (error instanceof Error && "code" in error && error.code === "PJ_STRUCTURAL_CHANGE")
    return "structural";
  if (error instanceof Error && error.name === "AbortError") return "interrupted";
  return "network";
}

function isInterruption(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof DiscoveryStopError && error.reason === "interrupted") ||
    (error instanceof HttpRequestError && error.classification === "interrupted") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name !== "" ? error.name : "Error";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true)
    throw new DiscoveryStopError("interrupted", "Descubrimiento interrumpido", {});
}

function assertPartition(page: DiscoveryPage, expected: string): void {
  if (page.partitionId !== expected)
    throw stop("partition_mismatch", "El adaptador devolvió otra partición", page, { expected });
}

function fingerprintFor(page: DiscoveryPage): string {
  return createHash("sha256")
    .update(JSON.stringify(page.parsed.records.map(({ nativeId }) => nativeId)))
    .digest("hex");
}

function newPartitionSummary(partitionId: string, page: DiscoveryPage): MutablePartitionSummary {
  return {
    partitionId,
    publishedGlobalTotal: page.parsed.publishedGlobalTotal,
    initialQueryTotal: page.parsed.queryTotal,
    finalQueryTotal: page.parsed.queryTotal,
    queryTotal: page.parsed.queryTotal,
    initialMaxPages: page.parsed.pagination.maxPages,
    finalMaxPages: page.parsed.pagination.maxPages,
    maxPages: page.parsed.pagination.maxPages,
    drift: false,
    pagesVisited: 0,
    rawMemberships: 0,
    uniqueMemberships: 0,
    duplicateMemberships: 0,
    newDocuments: 0,
    newCorpusMemberships: 0,
    globalDuplicates: 0,
    detailFailures: 0,
  };
}

function updateObservedTotals(summary: MutablePartitionSummary, page: DiscoveryPage): void {
  summary.finalQueryTotal = page.parsed.queryTotal;
  summary.queryTotal = summary.finalQueryTotal;
  summary.finalMaxPages = page.parsed.pagination.maxPages;
  summary.maxPages = summary.finalMaxPages;
  summary.drift =
    summary.initialQueryTotal !== summary.finalQueryTotal ||
    summary.initialMaxPages !== summary.finalMaxPages;
  summary.publishedGlobalTotal = page.parsed.publishedGlobalTotal;
}

function validateDocument(
  input: ScrapedDocument,
  record: DiscoveryRecord,
  page: DiscoveryPage,
  row: number,
): asserts input is ScrapedDocument {
  const document = scrapedDocumentSchema.parse(input);
  if (
    document.documentId !== record.nativeId ||
    document.partitionId !== page.partitionId ||
    document.sourcePage !== page.parsed.pagination.currentPage ||
    document.sourceRow !== row
  ) {
    throw stop("reconciliation_mismatch", "Documento enriquecido perdió su procedencia PJ", page, {
      documentId: document.documentId,
      nativeId: record.nativeId,
      sourcePage: document.sourcePage,
      sourceRow: document.sourceRow,
    });
  }
}

function validateNaturalEnd(summary: MutablePartitionSummary, page: DiscoveryPage): void {
  if (summary.rawMemberships !== summary.uniqueMemberships + summary.duplicateMemberships) {
    throw stop("reconciliation_mismatch", "Contabilidad de membresías no reconcilia", page, {
      rawMemberships: summary.rawMemberships,
      uniqueMemberships: summary.uniqueMemberships,
      duplicateMemberships: summary.duplicateMemberships,
    });
  }
  if (!summary.drift && summary.rawMemberships !== summary.finalQueryTotal) {
    throw stop("reconciliation_mismatch", "Fin natural no reconcilia con queryTotal", page, {
      queryTotal: summary.finalQueryTotal,
      rawMemberships: summary.rawMemberships,
      publishedGlobalTotal: summary.publishedGlobalTotal,
    });
  }
}

function stop(
  reason: ConstructorParameters<typeof DiscoveryStopError>[0],
  message: string,
  page: DiscoveryPage,
  extra: Readonly<Record<string, unknown>>,
): DiscoveryStopError {
  return new DiscoveryStopError(reason, message, {
    partitionId: page.partitionId,
    page: page.parsed.pagination.currentPage,
    fingerprint: fingerprintFor(page),
    ids: page.parsed.records.map(({ nativeId }) => nativeId),
    ...extra,
  });
}

function finalSummary(
  summaries: MutablePartitionSummary[],
  termination: SuccessfulTermination,
  datasetComplete: boolean,
): DiscoverySummary {
  const partitions = summaries.map((summary): PartitionDiscoverySummary => {
    summary.termination ??= termination;
    return { ...summary, termination: summary.termination };
  });
  const rawMemberships = partitions.reduce((sum, item) => sum + item.rawMemberships, 0);
  const uniqueDocuments = partitions.reduce((sum, item) => sum + item.newDocuments, 0);
  const duplicates = partitions.reduce((sum, item) => sum + item.globalDuplicates, 0);
  const detailFailures = partitions.reduce((sum, item) => sum + item.detailFailures, 0);
  const completeWithoutDetailFailures = datasetComplete && detailFailures === 0;
  return {
    termination,
    datasetComplete: completeWithoutDetailFailures,
    corpusGate: completeWithoutDetailFailures ? "pass" : "blocked",
    pagesVisited: partitions.reduce((sum, item) => sum + item.pagesVisited, 0),
    rawMemberships,
    uniqueDocuments,
    duplicates,
    detailFailures,
    partitions,
    diagnostics:
      termination === "natural_end" && !completeWithoutDetailFailures
        ? detailFailures > 0
          ? [`G3 bloqueado: ${String(detailFailures)} detalles no pudieron enriquecerse`]
          : ["G3 bloqueado: la reconciliación de corpus de fase 0.1 no está en PASS"]
        : [],
  };
}
