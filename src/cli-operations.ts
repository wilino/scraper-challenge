import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
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
import { DetailRetryService, type DetailRetryResult } from "./core/detail-retry-service.js";
import type { DiscoverySummary } from "./core/discovery-types.js";
import { DownloadManifestStore } from "./core/download-manifest-store.js";
import type { CompactDownloadState } from "./core/download-manifest-store.js";
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
import {
  ensureCorpusPlanArtifact,
  ensureExistingCorpusPlanArtifact,
  resolveCurrentCommit,
} from "./sites/pj/corpus-plan-artifact.js";
import { CORPUS_PLAN, selectCorpusPlan, type SelectedCorpusPlan } from "./sites/pj/corpus-plan.js";
import {
  PjCorpusDiscoverySource,
  type PjCorpusRecord,
} from "./sites/pj/corpus-discovery-source.js";
import { PjDiscoverySource } from "./sites/pj/discovery-source.js";
import { PjHistoricalAdapter } from "./sites/pj/historical-adapter.js";
import { PjHistoricalDiscoverySource } from "./sites/pj/historical-discovery-source.js";

class DownloadScanLimitReached extends Error {}
class DocumentPreflightComplete extends Error {}

async function ensureCompatibleDataset(
  config: ScraperConfig,
  plan: SelectedCorpusPlan = CORPUS_PLAN,
): Promise<void> {
  await ensureCorpusPlanArtifact(config.outputDir, await resolveCurrentCommit(process.cwd()), plan);
}

async function ensureCompatibleExistingDataset(config: ScraperConfig): Promise<SelectedCorpusPlan> {
  return await ensureExistingCorpusPlanArtifact(
    config.outputDir,
    await resolveCurrentCommit(process.cwd()),
  );
}

function detailRetryOperationSummary(
  result: DetailRetryResult,
  startedAt: number,
  rateLimitResponses: number,
): OperationSummary {
  return {
    command: "retry-details",
    partitions: documentPartitions(result.partitions),
    pdfs: { downloaded: 0, existing: 0, failed: 0 },
    rateLimitResponses,
    globalTotal: { initial: null, final: null },
    durationMs: duration(startedAt),
    stopReason: result.limited ? "limit" : result.stillFailed > 0 ? "failed" : "natural_end",
    definitiveFailures: result.remaining,
    corpusReconciled: false,
    detailRetries: {
      selected: result.selected,
      resolved: result.resolved,
      stillFailed: result.stillFailed,
      notEligible: result.notEligible,
    },
  };
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
      initialQueryTotal: partition.initialQueryTotal,
      finalQueryTotal: partition.finalQueryTotal,
      queryTotal: partition.queryTotal,
      initialMaxPages: partition.initialMaxPages,
      finalMaxPages: partition.finalMaxPages,
      drift: partition.drift,
      observed: partition.rawMemberships,
      inserted: partition.newDocuments,
      duplicates: partition.duplicateMemberships + partition.globalDuplicates,
      newMemberships: partition.newCorpusMemberships,
    })),
    pdfs: { downloaded: 0, existing: 0, failed: 0 },
    rateLimitResponses,
    globalTotal: {
      initial: totals[0] ?? null,
      final: totals.at(-1) ?? null,
    },
    durationMs: duration(startedAt),
    stopReason: result.termination,
    definitiveFailures: result.detailFailures,
    corpusReconciled: result.datasetComplete,
  };
}

function documentPartitions(grouped: ReadonlyMap<string, number>): PartitionSummary[] {
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
  partitions: ReadonlyMap<string, number>,
  result: DownloadRunResult,
  startedAt: number,
  rateLimitResponses: number,
  limited: boolean,
): OperationSummary {
  return {
    command,
    partitions: documentPartitions(partitions),
    pdfs: { downloaded: result.downloaded, existing: result.skipped, failed: result.failed },
    rateLimitResponses,
    globalTotal: { initial: null, final: null },
    durationMs: duration(startedAt),
    stopReason: limited ? "limit" : result.failed > 0 ? "failed" : "natural_end",
    definitiveFailures: result.failed,
    corpusReconciled: false,
  };
}

async function existingDocuments(
  config: ScraperConfig,
  signal?: AbortSignal,
): Promise<JsonlStore<ScrapedDocument>> {
  const filePath = path.join(config.outputDir, "data", "documents.jsonl");
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    throw new CliUsageError(
      "No existe data/documents.jsonl; ejecute discover antes de descargar PDFs",
    );
  }
  if (size === 0) {
    throw new CliUsageError(
      "data/documents.jsonl no contiene documentos; ejecute discover antes de descargar PDFs",
    );
  }
  const documents = new JsonlStore(filePath, scrapedDocumentSchema);
  const hasDocument = await documents
    .scan(() => {
      throw new DocumentPreflightComplete();
    }, signal)
    .then(() => false)
    .catch((error: unknown) => {
      if (error instanceof DocumentPreflightComplete) return true;
      throw error;
    });
  if (!hasDocument) {
    throw new CliUsageError(
      "data/documents.jsonl no contiene documentos; ejecute discover antes de descargar PDFs",
    );
  }
  return documents;
}

export interface DownloadDocumentScanSummary {
  documents: number;
  selected: number;
  partitions: Map<string, number>;
}

export function retryEligibleDocumentIds(
  manifestStates: ReadonlyMap<string, CompactDownloadState>,
  eligibleFailureIds: ReadonlySet<string>,
  signal?: AbortSignal,
): Set<string> {
  const documentIds = new Set<string>();
  for (const [documentId, state] of manifestStates) {
    signal?.throwIfAborted();
    if (
      typeof state !== "string" &&
      state.state === "failed" &&
      eligibleFailureIds.has(state.failureId)
    ) {
      documentIds.add(documentId);
    }
  }
  return documentIds;
}

export async function scanDownloadDocuments(
  documents: JsonlStore<ScrapedDocument>,
  retryEligibleIds: ReadonlySet<string> | undefined,
  visit: (document: ScrapedDocument) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<DownloadDocumentScanSummary> {
  const summary: DownloadDocumentScanSummary = {
    documents: 0,
    selected: 0,
    partitions: new Map(),
  };
  let reachedLimit = false;
  try {
    await documents.scan(async (document) => {
      summary.documents += 1;
      if (retryEligibleIds !== undefined && !retryEligibleIds.has(document.documentId)) return;
      summary.selected += 1;
      summary.partitions.set(
        document.partitionId,
        (summary.partitions.get(document.partitionId) ?? 0) + 1,
      );
      if (reachedLimit) throw new DownloadScanLimitReached();
      reachedLimit = !(await visit(document));
    }, signal);
  } catch (error: unknown) {
    if (!(error instanceof DownloadScanLimitReached)) throw error;
  }
  return summary;
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
    const plan = selectCorpusPlan(options.partitionId);
    await ensureCompatibleDataset(context.config, plan);
    const logger = createLogger({
      runId: randomUUID(),
      level: options.logLevel ?? context.config.logLevel,
      context: { command: "discover" },
    });
    const client = new PjHttpClient(context.config, { logger });
    const adapter = new PjAdapter(context.config, { http: client, logger });
    const historicalAdapter = new PjHistoricalAdapter(context.config, { http: client, logger });
    const orchestrator = new DiscoveryOrchestrator<PjCorpusRecord>({
      source: new PjCorpusDiscoverySource(
        new PjDiscoverySource(adapter),
        new PjHistoricalDiscoverySource(historicalAdapter),
        plan.partitionIds,
      ),
      outputDirectory: context.config.outputDir,
      baseUrl: context.config.baseUrl,
      queryHash: plan.queryHash,
      partitions: plan.partitionIds,
      corpusReconciliationPassed: false,
      passNumber: options.passNumber ?? 1,
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

  public async retryDetails(
    options: Parameters<CliOperations["retryDetails"]>[0],
    context: CommandContext,
  ): Promise<OperationSummary> {
    const startedAt = Date.now();
    const plan = await ensureCompatibleExistingDataset(context.config);
    const logger = createLogger({
      runId: randomUUID(),
      level: options.logLevel ?? context.config.logLevel,
      context: { command: "retry-details" },
    });
    const client = new PjHttpClient(context.config, { logger });
    const source = new PjCorpusDiscoverySource(
      new PjDiscoverySource(new PjAdapter(context.config, { http: client, logger })),
      new PjHistoricalDiscoverySource(
        new PjHistoricalAdapter(context.config, { http: client, logger }),
      ),
      plan.partitionIds,
    );
    try {
      const result = await new DetailRetryService({
        source,
        outputDirectory: context.config.outputDir,
      }).run({
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        signal: context.signal,
      });
      return detailRetryOperationSummary(
        result,
        startedAt,
        client.metricSnapshot().rateLimitResponses,
      );
    } finally {
      logger.flush();
    }
  }

  async #runDownload(
    command: "download" | "retry-failed",
    options: Parameters<CliOperations["download"]>[0],
    context: CommandContext,
  ): Promise<OperationSummary> {
    const startedAt = Date.now();
    await ensureCompatibleExistingDataset(context.config);
    const documents = await existingDocuments(context.config, context.signal);
    const manifestStore = new DownloadManifestStore(
      path.join(context.config.outputDir, "data", "download-manifest.jsonl"),
    );
    const failureStore = new FailureStore(
      path.join(context.config.outputDir, "data", "failures.jsonl"),
    );
    const manifestStates =
      command === "retry-failed" ? await manifestStore.compactStates(context.signal) : undefined;
    const retryEligibleIds =
      manifestStates === undefined
        ? undefined
        : retryEligibleDocumentIds(
            manifestStates,
            await failureStore.retryEligibleFailureIds(new Date(), context.signal),
            context.signal,
          );
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
      ...(manifestStates === undefined ? {} : { manifestStates }),
    });
    try {
      let scanSummary: DownloadDocumentScanSummary = {
        documents: 0,
        selected: 0,
        partitions: new Map(),
      };
      const result = await worker.runStreaming(
        async (visit) => {
          scanSummary = await scanDownloadDocuments(
            documents,
            retryEligibleIds,
            visit,
            context.signal,
          );
        },
        {
          ...(options.limit === undefined ? {} : { limit: options.limit }),
          ...(command === "retry-failed" ? { retryFailedOnly: true } : {}),
          signal: context.signal,
        },
      );
      if (scanSummary.documents === 0) {
        throw new CliUsageError(
          "data/documents.jsonl no contiene documentos; ejecute discover antes de descargar PDFs",
        );
      }
      return downloadOperationSummary(
        command,
        scanSummary.partitions,
        result,
        startedAt,
        client.metricSnapshot().rateLimitResponses,
        options.limit !== undefined &&
          result.processed >= options.limit &&
          scanSummary.selected > result.processed,
      );
    } finally {
      logger.flush();
    }
  }
}

export const defaultCliOperations = new DefaultCliOperations();
