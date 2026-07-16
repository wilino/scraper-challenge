import type { ScraperConfig } from "./config/env.js";
import type { Checkpoint } from "./models/checkpoint.js";

import type { CorpusPartitionId } from "./sites/pj/corpus-plan.js";

export type CommandName = "discover" | "download" | "retry-failed" | "retry-details";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type StopReason = "natural_end" | "limit" | "max_pages" | "interrupted" | "failed";

export interface CliOptions {
  resume: boolean;
  limit?: number;
  maxPages?: number;
  passNumber?: number;
  partitionId?: CorpusPartitionId;
  logLevel?: LogLevel;
}

export interface CliInvocation {
  command: CommandName;
  options: CliOptions;
}

export interface CommandContext {
  config: ScraperConfig;
  signal: AbortSignal;
}

export interface PartitionSummary {
  partitionId: string;
  pages: number;
  initialQueryTotal?: number;
  finalQueryTotal?: number;
  queryTotal: number;
  initialMaxPages?: number;
  finalMaxPages?: number;
  drift?: boolean;
  observed: number;
  inserted: number;
  duplicates: number;
  newMemberships?: number;
}

export interface OperationSummary {
  command: CommandName;
  partitions: PartitionSummary[];
  pdfs: {
    downloaded: number;
    existing: number;
    failed: number;
  };
  rateLimitResponses: number;
  globalTotal: { initial: number | null; final: number | null };
  durationMs: number;
  stopReason: StopReason;
  definitiveFailures: number;
  corpusReconciled: boolean;
  detailRetries?: {
    selected: number;
    resolved: number;
    stillFailed: number;
    notEligible: number;
  };
}

export interface CliOperations {
  discover(options: CliOptions, context: CommandContext): Promise<OperationSummary>;
  download(options: CliOptions, context: CommandContext): Promise<OperationSummary>;
  retryFailed(options: CliOptions, context: CommandContext): Promise<OperationSummary>;
  retryDetails(options: CliOptions, context: CommandContext): Promise<OperationSummary>;
  close?(): Promise<void>;
}

export class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export class CliInterruptedError extends Error {
  public readonly signalName: "SIGINT" | "SIGTERM";

  public constructor(signalName: "SIGINT" | "SIGTERM") {
    super(`Ejecución interrumpida por ${signalName}`);
    this.name = "CliInterruptedError";
    this.signalName = signalName;
  }
}

export interface ResumeContext {
  baseUrl: string;
  queryHash: string;
  partitionIds: ReadonlySet<string>;
}

export function validateResumeCheckpoint(checkpoint: Checkpoint, context: ResumeContext): void {
  if (new URL(checkpoint.baseUrl).origin !== new URL(context.baseUrl).origin) {
    throw new CliUsageError("El checkpoint pertenece a una URL PJ distinta");
  }
  if (checkpoint.queryHash !== context.queryHash) {
    throw new CliUsageError("El checkpoint no coincide con la consulta/configuración vigente");
  }
  if (!context.partitionIds.has(checkpoint.partitionId)) {
    throw new CliUsageError("La partición del checkpoint no existe en la estrategia vigente");
  }
}

export function createCommandHandler(operations: CliOperations) {
  return async (invocation: CliInvocation, context: CommandContext): Promise<OperationSummary> => {
    try {
      switch (invocation.command) {
        case "discover":
          return await operations.discover(invocation.options, context);
        case "download":
          return await operations.download(invocation.options, context);
        case "retry-failed":
          return await operations.retryFailed(invocation.options, context);
        case "retry-details":
          return await operations.retryDetails(invocation.options, context);
      }
    } finally {
      await operations.close?.();
    }
  };
}

export function formatOperationSummary(summary: OperationSummary): string {
  const complete =
    summary.stopReason === "natural_end" &&
    summary.corpusReconciled &&
    summary.definitiveFailures === 0;
  return JSON.stringify({
    ...summary,
    complete,
    completionNotice: complete
      ? "recorrido completo confirmado"
      : summary.stopReason === "limit" || summary.stopReason === "max_pages"
        ? "ejecución parcial por límite; no implica completitud"
        : !summary.corpusReconciled
          ? "corpus no reconciliado; no implica completitud"
          : "ejecución finalizada sin afirmar completitud",
  });
}
