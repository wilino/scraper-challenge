import { pathToFileURL } from "node:url";

import { ConfigurationError, loadConfig, type ScraperConfig } from "./config/env.js";
import {
  CliInterruptedError,
  CliUsageError,
  createCommandHandler,
  formatOperationSummary,
  type CliInvocation,
  type CliOptions,
  type CommandContext,
  type CommandName,
  type LogLevel,
  type OperationSummary,
} from "./cli-contract.js";
import { defaultCliOperations } from "./cli-operations.js";
import { HttpRequestError, PreflightError } from "./core/http-errors.js";
import { DiscoveryConfigurationError, DiscoveryStopError } from "./core/discovery-types.js";
import { PjStructuralError } from "./sites/pj/parser.js";
import { PjAdapterStateError } from "./sites/pj/adapter.js";

const COMMANDS = new Set<CommandName>(["discover", "download", "retry-failed"]);
const LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);
const SHUTDOWN_GRACE_MS = 5000;

const HELP = `Uso: npm run scrape -- <comando> [opciones]

Comandos:
  discover       Descubrir y persistir documentos; no descarga PDFs
  download       Descargar PDFs pendientes del manifest
  retry-failed   Reintentar fallos abiertos que ya sean elegibles

Opciones:
  --resume                    Reanudar discover desde un checkpoint compatible
  --limit <n>                 Limitar documentos procesados en esta ejecución
  --max-pages <n>             Limitar páginas de discover
  --log-level <nivel>         debug | info | warn | error
  -h, --help                  Mostrar ayuda

SIGINT finaliza con 130; SIGTERM finaliza con 143.`;

const COMMAND_HELP: Readonly<Record<CommandName, string>> = {
  discover: `Uso: npm run scrape -- discover [--resume] [--limit <n>] [--max-pages <n>] [--log-level <nivel>]`,
  download: `Uso: npm run scrape -- download [--limit <n>] [--log-level <nivel>]`,
  "retry-failed": `Uso: npm run scrape -- retry-failed [--limit <n>] [--log-level <nivel>]`,
};

export type CommandHandler = (
  invocation: CliInvocation,
  context: CommandContext,
) => Promise<OperationSummary | number>;

export interface RunCliDependencies {
  config?: ScraperConfig;
  signal?: AbortSignal;
  shutdownGraceMs?: number;
  writeOutput?: (message: string) => void;
  writeError?: (message: string) => void;
}

function isCommand(value: string): value is CommandName {
  return COMMANDS.has(value as CommandName);
}

function positiveInteger(raw: string | undefined, option: string): number {
  if (raw === undefined || !/^\d+$/u.test(raw) || Number(raw) < 1) {
    throw new CliUsageError(`${option} requiere un entero positivo`);
  }
  return Number(raw);
}

function assertOptionAllowed(command: CommandName, option: string): void {
  if (command !== "discover" && (option === "--resume" || option === "--max-pages")) {
    throw new CliUsageError(`${option} solo puede usarse con discover`);
  }
}

export function parseCliArguments(arguments_: readonly string[]): CliInvocation | null {
  const first = arguments_[0];
  if (first === undefined || first === "--help" || first === "-h") return null;
  if (!isCommand(first)) throw new CliUsageError(`Comando desconocido: ${first}. Use --help.`);
  if (arguments_.slice(1).some((value) => value === "--help" || value === "-h")) return null;

  const options: CliOptions = { resume: false };
  const seen = new Set<string>();
  for (let index = 1; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (!option?.startsWith("--")) {
      throw new CliUsageError(`Argumento inesperado: ${option ?? "(vacío)"}`);
    }
    if (seen.has(option)) throw new CliUsageError(`Opción repetida: ${option}`);
    seen.add(option);
    assertOptionAllowed(first, option);

    switch (option) {
      case "--resume":
        options.resume = true;
        break;
      case "--limit":
        options.limit = positiveInteger(arguments_[index + 1], option);
        index += 1;
        break;
      case "--max-pages":
        options.maxPages = positiveInteger(arguments_[index + 1], option);
        index += 1;
        break;
      case "--log-level": {
        const value = arguments_[index + 1];
        if (value === undefined || !LOG_LEVELS.has(value as LogLevel)) {
          throw new CliUsageError(`${option} requiere debug, info, warn o error`);
        }
        options.logLevel = value as LogLevel;
        index += 1;
        break;
      }
      default:
        throw new CliUsageError(`Opción desconocida: ${option}`);
    }
  }
  return { command: first, options };
}

function signalExitCode(error: CliInterruptedError): number {
  return error.signalName === "SIGINT" ? 130 : 143;
}

export function exitCodeForError(error: unknown): number {
  if (error instanceof CliInterruptedError) return signalExitCode(error);
  if (
    error instanceof CliUsageError ||
    error instanceof ConfigurationError ||
    error instanceof DiscoveryConfigurationError
  )
    return 2;
  if (error instanceof PreflightError) return 3;
  if (error instanceof PjStructuralError || error instanceof PjAdapterStateError) return 4;
  if (error instanceof DiscoveryStopError) return error.reason === "interrupted" ? 130 : 4;
  if (error instanceof HttpRequestError) {
    if (error.classification === "access") return 3;
    if (error.classification === "structural" || error.classification === "invalid_content")
      return 4;
    if (error.classification === "interrupted") return 130;
  }
  if (
    error instanceof Error &&
    [
      "JsfFormParseError",
      "JsfPartialResponseParseError",
      "JsfPostbackBuildError",
      "JsfResponseError",
      "JsfViewRecoveryExhaustedError",
    ].includes(error.name)
  ) {
    return 4;
  }
  return 1;
}

function interruptionAfter(signal: AbortSignal, graceMs: number): Promise<never> {
  return new Promise((_, reject) => {
    const interrupt = (): void => {
      const timer = setTimeout(() => {
        reject(
          signal.reason instanceof CliInterruptedError
            ? signal.reason
            : new CliInterruptedError("SIGINT"),
        );
      }, graceMs);
      timer.unref();
    };
    if (signal.aborted) interrupt();
    else signal.addEventListener("abort", interrupt, { once: true });
  });
}

const defaultHandler: CommandHandler = createCommandHandler(defaultCliOperations);

export async function runCli(
  arguments_: readonly string[],
  handler: CommandHandler = defaultHandler,
  dependencies: RunCliDependencies = {},
): Promise<number> {
  const startedAt = Date.now();
  const writeOutput = dependencies.writeOutput ?? console.log;
  const writeError = dependencies.writeError ?? console.error;
  try {
    const invocation = parseCliArguments(arguments_);
    if (invocation === null) {
      const command = arguments_[0];
      const commandHelp =
        command !== undefined && isCommand(command) ? COMMAND_HELP[command] : HELP;
      writeOutput(commandHelp);
      return 0;
    }
    const config = dependencies.config ?? loadConfig();
    const controller = new AbortController();
    const externalSignal = dependencies.signal;
    const forwardAbort = (): void => {
      controller.abort(externalSignal?.reason);
    };
    if (externalSignal?.aborted === true) forwardAbort();
    else externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      const operation = handler(invocation, { config, signal: controller.signal });
      const result = await Promise.race([
        operation,
        interruptionAfter(controller.signal, dependencies.shutdownGraceMs ?? SHUTDOWN_GRACE_MS),
      ]);
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof CliInterruptedError
          ? controller.signal.reason
          : new CliInterruptedError("SIGINT");
      }
      if (typeof result === "number") return result;
      writeOutput(formatOperationSummary(result));
      return result.definitiveFailures > 0 ? 5 : 0;
    } finally {
      externalSignal?.removeEventListener("abort", forwardAbort);
    }
  } catch (error: unknown) {
    const reportedError =
      dependencies.signal?.aborted === true &&
      dependencies.signal.reason instanceof CliInterruptedError
        ? dependencies.signal.reason
        : error;
    writeError(
      reportedError instanceof Error ? reportedError.message : "Error general no clasificado",
    );
    const command = arguments_[0];
    if (
      reportedError instanceof CliInterruptedError &&
      command !== undefined &&
      isCommand(command)
    ) {
      writeOutput(
        formatOperationSummary({
          command,
          partitions: [],
          pdfs: { downloaded: 0, existing: 0, failed: 0 },
          rateLimitResponses: 0,
          globalTotal: { initial: null, final: null },
          durationMs: Math.max(0, Date.now() - startedAt),
          stopReason: "interrupted",
          definitiveFailures: 0,
          corpusReconciled: false,
        }),
      );
    }
    return exitCodeForError(reportedError);
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort(new CliInterruptedError("SIGINT"));
  };
  const onSigterm = (): void => {
    controller.abort(new CliInterruptedError("SIGTERM"));
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    process.exitCode = await runCli(process.argv.slice(2), defaultHandler, {
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
