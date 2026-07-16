import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";

import {
  type CliOperations,
  CliUsageError,
  type CommandContext,
  type OperationSummary,
  type PartitionSummary,
} from "./cli-contract.js";
import type { ScraperConfig } from "./config/env.js";
import { DiscoveryOrchestrator } from "./core/discovery-orchestrator.js";
import type { DiscoverySummary } from "./core/discovery-types.js";
import { DownloadManifestStore } from "./core/download-manifest-store.js";
import { DownloadWorker, type DownloadRunResult } from "./core/download-worker.js";
import { FailureStore } from "./core/failure-store.js";
import { PjHttpClient } from "./core/http-client.js";
import { JsonlStore } from "./core/jsonl-store.js";
import { createLogger } from "./core/logger.js";
import { PdfDownloader } from "./core/pdf-downloader.js";
import { scrapedDocumentSchema, type ScrapedDocument } from "./models/document.js";
import type { DownloadManifestEvent } from "./models/download-manifest.js";
import type { ScrapeFailure } from "./models/failure.js";
import { PjAdapter } from "./sites/pj/adapter.js";
import { PjDiscoverySource } from "./sites/pj/discovery-source.js";
import type { PjListRecord } from "./sites/pj/parser.js";

const PARTITIONS = ["supreme", "superior"] as const;

function queryHash(): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        {
          court: "supreme",
          query: "",
          mode: "specialized",
          includeAutoQualifiers: true,
        },
        { court: "superior", query: "", mode: "general" },
      ]),
    )
    .digest("hex");
}

function duration(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function discoveryOperationSummary(
  result: DiscoverySummary,
  startedAt: number,
  rateLimitResponses: number,
): OperationSummary {
  const totals = result.partitions
    .map(({ publishedGlobalTotal }) => publishedGlobalTotal)
    .filter((value): value is number => value !== null);
  return {
    command: "discover",
    partitions: result.partitions.map((partition): PartitionSummary => ({
      partitionId: partition.partitionId,
      pages: partition.pagesVisited,
      queryTotal: partition.queryTotal,
      observed: partition.rawMemberships,
      inserted: partition.newDocuments,
      duplicates: partition.duplicateMemberships + partition.globalDuplicates,
    })),
    pdfs: { downloaded: 0, existing: 0, failed: 0 },
    rateLimitResponses,
    globalTotal: {
      initial: totals[0] ?? null,
      final: totals.at(-1) ?? null,
    },
    durationMs: duration(startedAt),
    stopReason: result.termination,
    definitiveFailures: 0,
    corpusReconciled: result.datasetComplete,
  };
}

function documentPartitions(documents: readonly ScrapedDocument[]): PartitionSummary[] {
  const grouped = new Map<string, number>();
  for (const document of documents) {
    grouped.set(document.partitionId, (grouped.get(document.partitionId) ?? 0) + 1);
  }
  return [...grouped].map(([partitionId, documentsCount]) => ({
    partitionId,
    pages: 0,
    queryTotal: documentsCount,
    observed: documentsCount,
    inserted: 0,
    duplicates: 0,
  }));
}

function downloadOperationSummary(
  command: "download" | "retry-failed",
  documents: readonly ScrapedDocument[],
  result: DownloadRunResult,
  startedAt: number,
  rateLimitResponses: number,
  limited: boolean,
): OperationSummary {
  return {
    command,
    partitions: documentPartitions(documents),
    pdfs: { downloaded: result.downloaded, existing: result.skipped, failed: result.failed },
    rateLimitResponses,
    globalTotal: { initial: null, final: null },
    durationMs: duration(startedAt),
    stopReason: limited ? "limit" : result.failed > 0 ? "failed" : "natural_end",
    definitiveFailures: result.failed,
    corpusReconciled: false,
  };
}

async function existingDocuments(config: ScraperConfig): Promise<ScrapedDocument[]> {
  const filePath = path.join(config.outputDir, "data", "documents.jsonl");
  try {
    await access(filePath);
  } catch {
    throw new CliUsageError(
      "No existe data/documents.jsonl; ejecute discover antes de descargar PDFs",
    );
  }
  const { records } = await new JsonlStore(filePath, scrapedDocumentSchema).readAll();
  if (records.length === 0) {
    throw new CliUsageError(
      "data/documents.jsonl no contiene documentos; ejecute discover antes de descargar PDFs",
    );
  }
  return records;
}

export function selectRetryEligibleDocuments(
  documents: readonly ScrapedDocument[],
  failures: readonly ScrapeFailure[],
  currentManifest: ReadonlyMap<string, DownloadManifestEvent>,
  now: Date,
): ScrapedDocument[] {
  const failuresById = new Map(failures.map((failure) => [failure.failureId, failure]));
  return documents.filter(({ documentId }) => {
    const manifest = currentManifest.get(documentId);
    if (manifest?.state !== "failed") return false;
    const failure = failuresById.get(manifest.failureId);
    return (
      failure?.retryable === true &&
      failure.resolution === "open" &&
      (failure.nextRetryAt === undefined || Date.parse(failure.nextRetryAt) <= now.getTime())
    );
  });
}

export class DefaultCliOperations implements CliOperations {
  public async discover(
    options: Parameters<CliOperations["discover"]>[0],
    context: CommandContext,
  ): Promise<OperationSummary> {
    const startedAt = Date.now();
    const logger = createLogger({
      runId: randomUUID(),
      level: options.logLevel ?? context.config.logLevel,
      context: { command: "discover" },
    });
    const client = new PjHttpClient(context.config, { logger });
    const adapter = new PjAdapter(context.config, { http: client, logger });
    const orchestrator = new DiscoveryOrchestrator<PjListRecord>({
      source: new PjDiscoverySource(adapter),
      outputDirectory: context.config.outputDir,
      baseUrl: context.config.baseUrl,
      queryHash: queryHash(),
      partitions: PARTITIONS,
      corpusReconciliationPassed: false,
    });
    try {
      const result = await orchestrator.run({
        resume: options.resume,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
        signal: context.signal,
      });
      return discoveryOperationSummary(
        result,
        startedAt,
        client.metricSnapshot().rateLimitResponses,
      );
    } finally {
      logger.flush();
    }
  }

  public download(
    options: Parameters<CliOperations["download"]>[0],
    context: CommandContext,
  ): Promise<OperationSummary> {
    return this.#runDownload("download", options, context);
  }

  public retryFailed(
    options: Parameters<CliOperations["retryFailed"]>[0],
    context: CommandContext,
  ): Promise<OperationSummary> {
    return this.#runDownload("retry-failed", options, context);
  }

  async #runDownload(
    command: "download" | "retry-failed",
    options: Parameters<CliOperations["download"]>[0],
    context: CommandContext,
  ): Promise<OperationSummary> {
    const startedAt = Date.now();
    const documents = await existingDocuments(context.config);
    const manifestStore = new DownloadManifestStore(
      path.join(context.config.outputDir, "data", "download-manifest.jsonl"),
    );
    const failureStore = new FailureStore(
      path.join(context.config.outputDir, "data", "failures.jsonl"),
    );
    let selected = documents;
    if (command === "retry-failed") {
      const [failureHistory, currentManifest] = await Promise.all([
        failureStore.readAll(),
        manifestStore.currentStates(),
      ]);
      selected = selectRetryEligibleDocuments(
        documents,
        failureHistory.records,
        currentManifest,
        new Date(),
      );
    }
    const logger = createLogger({
      runId: randomUUID(),
      level: options.logLevel ?? context.config.logLevel,
      context: { command },
    });
    const client = new PjHttpClient(context.config, { logger });
    const worker = new DownloadWorker({
      downloader: new PdfDownloader(client, {
        outputDir: context.config.outputDir,
        maxPdfBytes: context.config.maxPdfBytes,
        timeoutMs: context.config.pdfTimeoutMs,
        maxStreamRetries: context.config.maxRetries,
        retryBaseMs: context.config.backoffBaseMs,
      }),
      manifestStore,
      failureStore,
    });
    try {
      const result = await worker.run(selected, {
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(command === "retry-failed" ? { retryFailedOnly: true } : {}),
        signal: context.signal,
      });
      return downloadOperationSummary(
        command,
        selected,
        result,
        startedAt,
        client.metricSnapshot().rateLimitResponses,
        options.limit !== undefined &&
          result.processed >= options.limit &&
          selected.length > result.processed,
      );
    } finally {
      logger.flush();
    }
  }
}

export const defaultCliOperations = new DefaultCliOperations();
