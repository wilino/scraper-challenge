import { randomUUID } from "node:crypto";

import {
  compactState,
  type CompactDownloadState,
  type DownloadManifestStore,
  type DownloadResumeState,
} from "./download-manifest-store.js";
import type { FailureStore } from "./failure-store.js";
import { HttpRequestError } from "./http-errors.js";
import { PdfDownloadError, type PdfDownloader } from "./pdf-downloader.js";
import type { DownloadManifestEvent } from "../models/download-manifest.js";
import type { ScrapedDocument } from "../models/document.js";
import type { ScrapeFailure } from "../models/failure.js";

export interface DownloadWorkerOptions {
  limit?: number;
  retryFailedOnly?: boolean;
  signal?: AbortSignal;
}

export interface DownloadRunResult {
  processed: number;
  downloaded: number;
  skipped: number;
  failed: number;
  noPdf: number;
}

export interface DownloadWorkerDependencies {
  downloader: PdfDownloader;
  manifestStore: DownloadManifestStore;
  failureStore: FailureStore;
  manifestStates?: Map<string, CompactDownloadState>;
  now?: () => Date;
  createId?: () => string;
}

/** El scanner debe detener la producción cuando visit devuelve false. */
export type DownloadDocumentScanner = (
  visit: (document: ScrapedDocument) => Promise<boolean>,
) => Promise<void>;

function globalFailure(error: unknown): boolean {
  return (
    error instanceof HttpRequestError &&
    (error.classification === "access" || error.classification === "security")
  );
}

function failureClassification(error: unknown): ScrapeFailure["classification"] {
  if (error instanceof HttpRequestError) {
    if (error.classification === "rate_limit") return "rate_limit";
    if (error.classification === "http_permanent") return "http_permanent";
    if (error.classification === "timeout") return "timeout";
    if (error.classification === "security") return "security";
    if (error.classification === "access") return "access";
    if (error.classification === "interrupted") return "interrupted";
    return error.classification === "invalid_content" ? "invalid_content" : "network";
  }
  if (error instanceof PdfDownloadError) {
    if (error.code === "PDF_TIMEOUT") return "timeout";
    return error.retryable ? "network" : "invalid_content";
  }
  return "network";
}

export class DownloadWorker {
  readonly #now: () => Date;
  readonly #createId: () => string;

  public constructor(private readonly dependencies: DownloadWorkerDependencies) {
    this.#now = dependencies.now ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
  }

  public async run(
    documents: readonly ScrapedDocument[],
    options: DownloadWorkerOptions = {},
  ): Promise<DownloadRunResult> {
    return await this.#run(async (visit) => {
      for (const document of documents) if (!(await visit(document))) break;
    }, options);
  }

  public async runStreaming(
    scan: DownloadDocumentScanner,
    options: DownloadWorkerOptions = {},
  ): Promise<DownloadRunResult> {
    return await this.#run(scan, options);
  }

  async #run(
    scan: DownloadDocumentScanner,
    options: DownloadWorkerOptions,
  ): Promise<DownloadRunResult> {
    options.signal?.throwIfAborted();
    let initialization: Promise<Map<string, CompactDownloadState>> | undefined;
    const initialize = (): Promise<Map<string, CompactDownloadState>> => {
      initialization ??= (async () => {
        options.signal?.throwIfAborted();
        await this.dependencies.downloader.initialize();
        return (
          this.dependencies.manifestStates ??
          (await this.dependencies.manifestStore.compactStates(options.signal))
        );
      })();
      return initialization;
    };
    const result: DownloadRunResult = {
      processed: 0,
      downloaded: 0,
      skipped: 0,
      failed: 0,
      noPdf: 0,
    };
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    await scan(async (document) => {
      if (result.processed >= limit) return false;
      options.signal?.throwIfAborted();
      const states = await initialize();
      let current = states.get(document.documentId);
      if (document.pdf.state === "no_pdf") {
        if (options.retryFailedOnly === true) return true;
        if (current !== "no_pdf") {
          const event = await this.appendNoPdf(document);
          states.set(document.documentId, compactState(event));
        }
        result.processed += 1;
        result.noPdf += 1;
        return result.processed < limit;
      }
      if (
        options.retryFailedOnly === true &&
        (typeof current === "string" || current?.state !== "failed")
      )
        return true;
      if (current === undefined) {
        const event = await this.appendPending(document);
        current = compactState(event);
        states.set(document.documentId, current);
      }
      result.processed += 1;
      try {
        const downloaded = await this.dependencies.downloader.download(
          document,
          resumeState(current),
          options.signal,
        );
        if (downloaded.state === "skipped") {
          result.skipped += 1;
          return result.processed < limit;
        }
        const occurredAt = this.#now().toISOString();
        if (typeof current !== "string" && current.state === "failed") {
          await this.dependencies.failureStore.resolve(
            current.failureId,
            occurredAt,
            options.signal,
          );
        }
        const event: DownloadManifestEvent = {
          schemaVersion: 1,
          eventId: this.#createId(),
          documentId: document.documentId,
          occurredAt,
          state: "downloaded",
          request: document.pdf.request,
          relativePath: downloaded.relativePath,
          sha256: downloaded.sha256,
          bytes: downloaded.bytes,
          effectiveUrl: downloaded.effectiveUrl,
        };
        await this.dependencies.manifestStore.append(event);
        states.set(document.documentId, compactState(event));
        result.downloaded += 1;
      } catch (error: unknown) {
        if (globalFailure(error)) throw error;
        const failure = await this.appendFailure(document, error, options.signal);
        const event: DownloadManifestEvent = {
          schemaVersion: 1,
          eventId: this.#createId(),
          documentId: document.documentId,
          occurredAt: this.#now().toISOString(),
          state: "failed",
          request: document.pdf.request,
          failureId: failure.failureId,
        };
        await this.dependencies.manifestStore.append(event);
        states.set(document.documentId, compactState(event));
        result.failed += 1;
      }
      return result.processed < limit;
    });
    return result;
  }

  private async appendPending(document: ScrapedDocument): Promise<DownloadManifestEvent> {
    if (document.pdf.state !== "pending") throw new Error("Documento sin descriptor PDF");
    const event: DownloadManifestEvent = {
      schemaVersion: 1,
      eventId: this.#createId(),
      documentId: document.documentId,
      occurredAt: this.#now().toISOString(),
      state: "pending",
      request: document.pdf.request,
    };
    await this.dependencies.manifestStore.append(event);
    return event;
  }

  private async appendNoPdf(document: ScrapedDocument): Promise<DownloadManifestEvent> {
    if (document.pdf.state !== "no_pdf") throw new Error("Documento con descriptor PDF");
    const event: DownloadManifestEvent = {
      schemaVersion: 1,
      eventId: this.#createId(),
      documentId: document.documentId,
      occurredAt: this.#now().toISOString(),
      state: "no_pdf",
      reason: document.pdf.reason,
    };
    await this.dependencies.manifestStore.append(event);
    return event;
  }

  private async appendFailure(
    document: ScrapedDocument,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<ScrapeFailure> {
    if (document.pdf.state !== "pending") throw new Error("Documento sin descriptor PDF");
    const now = this.#now();
    const retryable =
      error instanceof HttpRequestError
        ? error.retryable
        : error instanceof PdfDownloadError
          ? error.retryable
          : false;
    const attempts =
      error instanceof HttpRequestError
        ? error.attempt
        : error instanceof PdfDownloadError
          ? error.attempts
          : 1;
    const failure: ScrapeFailure = {
      schemaVersion: 1,
      failureId: this.#createId(),
      phase: "download",
      partitionId: document.partitionId,
      documentId: document.documentId,
      request: document.pdf.request,
      classification: failureClassification(error),
      attempts,
      retryable,
      message: error instanceof Error ? error.message : "Fallo de descarga desconocido",
      ...(error instanceof HttpRequestError && error.status !== undefined
        ? { status: error.status }
        : {}),
      ...(error instanceof HttpRequestError && error.code !== undefined
        ? { code: error.code }
        : error instanceof PdfDownloadError
          ? { code: error.code }
          : {}),
      ...(error instanceof HttpRequestError && error.retryAfterMs !== undefined
        ? {
            retryAfterMs: error.retryAfterMs,
            nextRetryAt: new Date(now.getTime() + error.retryAfterMs).toISOString(),
          }
        : {}),
      resolution: "open",
      occurredAt: now.toISOString(),
    };
    await this.dependencies.failureStore.append(failure, signal);
    return failure;
  }
}

function resumeState(current: CompactDownloadState): DownloadResumeState | undefined {
  return typeof current === "string" ? undefined : current;
}
