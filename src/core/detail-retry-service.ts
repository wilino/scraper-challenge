import { randomUUID } from "node:crypto";

import { downloadManifestEventSchema } from "../models/download-manifest.js";
import type { ScrapeFailure } from "../models/failure.js";
import type { DiscoveryRecord, DiscoverySource } from "./discovery-types.js";
import { DiscoverySessionStateError } from "./discovery-types.js";
import { DownloadManifestStore } from "./download-manifest-store.js";
import { FailureStore } from "./failure-store.js";
import { HttpRequestError } from "./http-errors.js";
import { PagePersistence } from "./page-persistence.js";

export interface DetailRetryResult {
  selected: number;
  resolved: number;
  stillFailed: number;
  notEligible: number;
  remaining: number;
  limited: boolean;
  partitions: Map<string, number>;
}

export interface DetailRetryOptions {
  limit?: number;
  signal?: AbortSignal;
}

export class DetailRetryService<TRecord extends DiscoveryRecord> {
  readonly #source: DiscoverySource<TRecord>;
  readonly #persistence: PagePersistence;
  readonly #manifest: DownloadManifestStore;
  readonly #failures: FailureStore;
  readonly #now: () => Date;
  readonly #uuid: () => string;

  public constructor(options: {
    source: DiscoverySource<TRecord>;
    outputDirectory: string;
    now?: () => Date;
    uuid?: () => string;
  }) {
    this.#source = options.source;
    this.#persistence = new PagePersistence(options.outputDirectory);
    this.#manifest = new DownloadManifestStore(
      `${options.outputDirectory}/data/download-manifest.jsonl`,
    );
    this.#failures = new FailureStore(`${options.outputDirectory}/data/failures.jsonl`);
    this.#now = options.now ?? (() => new Date());
    this.#uuid = options.uuid ?? randomUUID;
  }

  public async run(options: DetailRetryOptions = {}): Promise<DetailRetryResult> {
    validateLimit(options.limit);
    options.signal?.throwIfAborted();
    await this.#persistence.scanDocuments(() => undefined, options.signal);
    const manifestIds = await this.#manifest.documentIds(options.signal);
    const current = await this.#failures.currentFailures("detail", options.signal);
    const eligible = await this.#failures.retryEligibleDetailFailures(this.#now(), options.signal);
    const selected = eligible
      .slice(0, options.limit)
      .sort(
        (left, right) =>
          (left.partitionId ?? "").localeCompare(right.partitionId ?? "") ||
          (left.page ?? 0) - (right.page ?? 0),
      );
    const partitions = new Map<string, number>();
    let resolved = 0;
    let stillFailed = 0;

    if (selected.length > 0) await this.#source.preflight(options.signal);
    for (const failure of selected) {
      options.signal?.throwIfAborted();
      const partitionId = requiredDescriptor(failure, "partitionId");
      const documentId = requiredDescriptor(failure, "documentId");
      const pageNumber = requiredDescriptor(failure, "page");
      partitions.set(partitionId, (partitions.get(partitionId) ?? 0) + 1);
      if (this.#persistence.hasDocument(documentId)) {
        await this.#failures.resolve(failure.failureId, this.#now().toISOString(), options.signal);
        resolved += 1;
        continue;
      }
      try {
        const page = await this.#source.openPartition(partitionId, pageNumber, options.signal);
        const row = page.parsed.records.findIndex((record) => record.nativeId === documentId);
        const record = page.parsed.records[row];
        if (record === undefined) {
          throw new DiscoverySessionStateError(
            `El documento ${documentId} ya no aparece en ${partitionId}, página ${String(pageNumber)}`,
          );
        }
        const document = await this.#source.enrichRecord(record, {
          partitionId,
          page: pageNumber,
          row,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (document.documentId !== documentId || document.partitionId !== partitionId) {
          throw new DiscoverySessionStateError("El detalle recuperado no conserva su identidad");
        }
        if (!manifestIds.has(documentId)) {
          const base = {
            schemaVersion: 1 as const,
            eventId: this.#uuid(),
            documentId,
            occurredAt: this.#now().toISOString(),
          };
          await this.#manifest.append(
            downloadManifestEventSchema.parse(
              document.pdf.state === "pending"
                ? { ...base, state: "pending", request: document.pdf.request }
                : { ...base, state: "no_pdf", reason: document.pdf.reason },
            ),
          );
          manifestIds.add(documentId);
        }
        await this.#persistence.persistDocuments([document]);
        await this.#failures.resolve(failure.failureId, this.#now().toISOString(), options.signal);
        resolved += 1;
      } catch (error: unknown) {
        if (isInterruption(error, options.signal)) throw error;
        await this.#failures.upsertOpenForDocument(
          retriedFailure(failure, error, this.#now()),
          options.signal,
        );
        stillFailed += 1;
      }
    }
    return {
      selected: selected.length,
      resolved,
      stillFailed,
      notEligible: current.length - eligible.length,
      remaining: current.length - resolved,
      limited: selected.length < eligible.length,
      partitions,
    };
  }
}

function requiredDescriptor<K extends "partitionId" | "documentId" | "page">(
  failure: ScrapeFailure,
  key: K,
): NonNullable<ScrapeFailure[K]> {
  const value = failure[key];
  if (value === undefined) {
    throw new Error(`Fallo detail v1 sin descriptor ${key}; repita discover para reconstruirlo`);
  }
  return value;
}

function retriedFailure(failure: ScrapeFailure, error: unknown, now: Date): ScrapeFailure {
  const http = error instanceof HttpRequestError ? error : undefined;
  const classification = classify(error);
  const retryable =
    http?.retryable ?? (classification === "network" || classification === "timeout");
  return {
    ...failure,
    classification,
    attempts: failure.attempts + (http?.attempt ?? 1),
    retryable,
    message: `Detalle PJ incompleto (${error instanceof Error ? error.name : "Error"})`,
    ...(http?.status === undefined ? {} : { status: http.status }),
    ...(http?.code === undefined ? {} : { code: http.code }),
    ...(http?.retryAfterMs === undefined
      ? { retryAfterMs: undefined, nextRetryAt: undefined }
      : {
          retryAfterMs: http.retryAfterMs,
          nextRetryAt: new Date(now.getTime() + http.retryAfterMs).toISOString(),
        }),
    resolution: "open",
    occurredAt: now.toISOString(),
    resolvedAt: undefined,
  };
}

function classify(error: unknown): ScrapeFailure["classification"] {
  if (error instanceof HttpRequestError) {
    if (error.classification === "http_transient") return "network";
    if (error.classification === "session_invalid") return "structural";
    return error.classification;
  }
  if (error instanceof DiscoverySessionStateError) return "structural";
  if (error instanceof Error && error.name === "AbortError") return "interrupted";
  return "network";
}

function isInterruption(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof HttpRequestError && error.classification === "interrupted") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function validateLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("limit debe ser un entero positivo");
  }
}
