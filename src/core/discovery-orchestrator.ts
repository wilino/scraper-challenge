import { createHash, randomUUID } from "node:crypto";

import { DownloadManifestStore } from "./download-manifest-store.js";
import { FailureStore } from "./failure-store.js";
import {
  DiscoveryConfigurationError,
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
import {
  downloadManifestEventSchema,
  type DownloadManifestEvent,
} from "../models/download-manifest.js";
import { scrapedDocumentSchema, type ScrapedDocument } from "../models/document.js";
import type { ScrapeFailure } from "../models/failure.js";

export interface DiscoveryOrchestratorOptions<TRecord extends DiscoveryRecord = DiscoveryRecord> {
  source: DiscoverySource<TRecord>;
  outputDirectory: string;
  baseUrl: string;
  queryHash: string;
  partitions: readonly string[];
  corpusReconciliationPassed?: boolean;
  now?: () => Date;
  uuid?: () => string;
}

interface MutablePartitionSummary {
  partitionId: string;
  publishedGlobalTotal: number | null;
  queryTotal: number;
  maxPages: number;
  pagesVisited: number;
  rawMemberships: number;
  uniqueMemberships: number;
  duplicateMemberships: number;
  newDocuments: number;
  globalDuplicates: number;
  termination?: SuccessfulTermination;
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
    this.#now = options.now ?? (() => new Date());
    this.#uuid = options.uuid ?? randomUUID;
    checkpointSchema.shape.queryHash.parse(options.queryHash);
  }

  public async run(options: DiscoveryRunOptions = {}): Promise<DiscoverySummary> {
    validateLimit(options.limit, "limit");
    validateLimit(options.maxPages, "maxPages");
    throwIfAborted(options.signal);
    const storedDocuments = await this.#persistence.initialize();
    const manifestStates = new Map(await this.#manifest.currentStates());
    for (const document of storedDocuments) await this.#ensureManifest(document, manifestStates);
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
          if (this.#persistence.hasDocument(record.nativeId)) {
            summary.globalDuplicates += 1;
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
            await this.#recordDetailFailure(record.nativeId, partitionId, page, error);
            throw error;
          }
          validateDocument(document, record, page, row);
          await this.#ensureManifest(document, manifestStates);
          const inserted = await this.#persistence.confirmDocuments(
            [document],
            this.#checkpoint(partitionId, page.parsed.pagination.currentPage, row + 1),
          );
          if (inserted === 1) {
            summary.newDocuments += 1;
            totalNewDocuments += 1;
          } else {
            summary.globalDuplicates += 1;
          }
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

  async #ensureManifest(
    document: ScrapedDocument,
    states: Map<string, DownloadManifestEvent>,
  ): Promise<void> {
    if (states.has(document.documentId)) return;
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
    states.set(document.documentId, event);
  }

  async #recordDetailFailure(
    documentId: string,
    partitionId: string,
    page: DiscoveryPage,
    error: unknown,
  ): Promise<void> {
    const classification = classifyDetailFailure(error);
    const failure: ScrapeFailure = {
      schemaVersion: 1,
      failureId: this.#uuid(),
      phase: "detail",
      partitionId,
      documentId,
      page: page.parsed.pagination.currentPage,
      classification,
      attempts: 1,
      retryable: classification === "network" || classification === "timeout",
      message: `Detalle PJ incompleto (${errorName(error)})`,
      resolution: "open",
      occurredAt: this.#now().toISOString(),
    };
    await this.#failures.append(failure);
  }
}

function validateLimit(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1))
    throw new Error(`${name} debe ser un entero positivo`);
}

function classifyDetailFailure(error: unknown): ScrapeFailure["classification"] {
  if (error instanceof DiscoveryStopError && error.reason === "interrupted") return "interrupted";
  if (error instanceof Error && "code" in error && error.code === "PJ_STRUCTURAL_CHANGE")
    return "structural";
  if (error instanceof Error && error.name === "AbortError") return "interrupted";
  return "network";
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
    queryTotal: page.parsed.queryTotal,
    maxPages: page.parsed.pagination.maxPages,
    pagesVisited: 0,
    rawMemberships: 0,
    uniqueMemberships: 0,
    duplicateMemberships: 0,
    newDocuments: 0,
    globalDuplicates: 0,
  };
}

function updateObservedTotals(summary: MutablePartitionSummary, page: DiscoveryPage): void {
  if (
    summary.queryTotal !== page.parsed.queryTotal ||
    summary.maxPages !== page.parsed.pagination.maxPages
  ) {
    throw stop(
      "reconciliation_mismatch",
      "Totales de consulta PJ cambiaron durante la partición",
      page,
      {
        initialQueryTotal: summary.queryTotal,
        observedQueryTotal: page.parsed.queryTotal,
        initialMaxPages: summary.maxPages,
        observedMaxPages: page.parsed.pagination.maxPages,
      },
    );
  }
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
  if (summary.rawMemberships !== summary.queryTotal) {
    throw stop("reconciliation_mismatch", "Fin natural no reconcilia con queryTotal", page, {
      queryTotal: summary.queryTotal,
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
  return {
    termination,
    datasetComplete,
    corpusGate: datasetComplete ? "pass" : "blocked",
    pagesVisited: partitions.reduce((sum, item) => sum + item.pagesVisited, 0),
    rawMemberships,
    uniqueDocuments,
    duplicates,
    partitions,
    diagnostics:
      termination === "natural_end" && !datasetComplete
        ? ["G3 bloqueado: la reconciliación de corpus de fase 0.1 no está en PASS"]
        : [],
  };
}
