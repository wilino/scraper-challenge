import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CliInterruptedError,
  CliUsageError,
  createCommandHandler,
  formatOperationSummary,
  validateResumeCheckpoint,
  type OperationSummary,
} from "../../src/cli-contract.js";
import { exitCodeForError, parseCliArguments, runCli, type CommandHandler } from "../../src/cli.js";
import { selectRetryEligibleDocuments } from "../../src/cli-operations.js";
import type { ScraperConfig } from "../../src/config/env.js";
import { PreflightError } from "../../src/core/http-errors.js";
import { PjStructuralError } from "../../src/sites/pj/parser.js";

const config: ScraperConfig = {
  baseUrl: "https://jurisprudencia.pj.gob.pe",
  startPath: "/jurisprudenciaweb/faces/page/inicio.xhtml",
  resultsPath: "/jurisprudenciaweb/faces/page/resultado.xhtml",
  outputDir: "/tmp/pj-cli-test",
  requestTimeoutMs: 1000,
  connectTimeoutMs: 1000,
  pdfTimeoutMs: 1000,
  minRequestDelayMs: 1,
  maxRequestDelayMs: 1,
  maxRetries: 1,
  backoffBaseMs: 1,
  backoffMaxMs: 1,
  globalCooldownAfter429Ms: 1,
  maxPages: 10,
  maxDocuments: 10,
  maxPdfBytes: 1024,
  maxHtmlBytes: 1024,
  htmlConcurrency: 1,
  pdfConcurrency: 1,
  userAgent: "test",
  logLevel: "silent",
};

const summary = (overrides: Partial<OperationSummary> = {}): OperationSummary => ({
  command: "discover",
  partitions: [
    {
      partitionId: "supreme",
      pages: 2,
      queryTotal: 20,
      observed: 20,
      inserted: 18,
      duplicates: 2,
    },
  ],
  pdfs: { downloaded: 0, existing: 0, failed: 0 },
  rateLimitResponses: 0,
  globalTotal: { initial: 20, final: 20 },
  durationMs: 100,
  stopReason: "natural_end",
  definitiveFailures: 0,
  corpusReconciled: true,
  ...overrides,
});

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Se esperaba un objeto JSON");
  }
  return parsed as Record<string, unknown>;
}

describe("argumentos CLI", () => {
  it("muestra ayuda global y por comando con código 0", async () => {
    const output = vi.fn();
    await expect(runCli(["--help"], undefined, { config, writeOutput: output })).resolves.toBe(0);
    await expect(
      runCli(["download", "--help"], undefined, { config, writeOutput: output }),
    ).resolves.toBe(0);
    expect(output).toHaveBeenNthCalledWith(1, expect.stringContaining("retry-failed"));
    expect(output).toHaveBeenNthCalledWith(2, expect.stringContaining("download"));
  });

  it("parsea únicamente las opciones MVP", () => {
    expect(
      parseCliArguments([
        "discover",
        "--resume",
        "--limit",
        "25",
        "--max-pages",
        "2",
        "--log-level",
        "debug",
      ]),
    ).toEqual({
      command: "discover",
      options: { resume: true, limit: 25, maxPages: 2, logLevel: "debug" },
    });
  });

  it.each([
    ["inexistente"],
    ["discover", "--limit", "0"],
    ["discover", "--limit", "uno"],
    ["discover", "--log-level", "trace"],
    ["download", "--resume"],
    ["retry-failed", "--max-pages", "2"],
    ["download", "--extra"],
    ["discover", "--resume", "--resume"],
  ])("rechaza uso inválido con código 2: %j", async (...arguments_) => {
    await expect(runCli(arguments_, undefined, { config, writeError: vi.fn() })).resolves.toBe(2);
  });
});

describe("delegación y resumen CLI", () => {
  it.each(["discover", "download", "retry-failed"] as const)(
    "delega %s con opciones, configuración y señal",
    async (command) => {
      const handler = vi.fn<CommandHandler>(() => Promise.resolve(summary({ command })));
      await expect(
        runCli([command, "--limit", "3"], handler, { config, writeOutput: vi.fn() }),
      ).resolves.toBe(0);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0]?.[0]).toEqual({
        command,
        options: { resume: false, limit: 3 },
      });
      expect(handler.mock.calls[0]?.[1].config).toBe(config);
      expect(handler.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    },
  );

  it("devuelve 5 y conserva el resumen cuando existen fallos definitivos", async () => {
    const output = vi.fn();
    const handler = vi.fn(() =>
      Promise.resolve(
        summary({ command: "download", definitiveFailures: 2, stopReason: "failed" }),
      ),
    );
    await expect(runCli(["download"], handler, { config, writeOutput: output })).resolves.toBe(5);
    expect(parseObject(String(output.mock.calls[0]?.[0]))).toMatchObject({
      definitiveFailures: 2,
      complete: false,
    });
  });

  it("diferencia una parada por límite de completitud real", () => {
    expect(parseObject(formatOperationSummary(summary())).complete).toBe(true);
    const limited = parseObject(formatOperationSummary(summary({ stopReason: "limit" })));
    expect(limited.complete).toBe(false);
    expect(String(limited.completionNotice)).toContain("no implica completitud");
    expect(parseObject(formatOperationSummary(summary({ corpusReconciled: false }))).complete).toBe(
      false,
    );
  });

  it("el adaptador de operaciones enruta los tres comandos y cierra recursos", async () => {
    const operations = {
      discover: vi.fn(() => Promise.resolve(summary())),
      download: vi.fn(() => Promise.resolve(summary({ command: "download" }))),
      retryFailed: vi.fn(() => Promise.resolve(summary({ command: "retry-failed" }))),
      close: vi.fn(() => Promise.resolve()),
    };
    const handler = createCommandHandler(operations);
    const context = { config, signal: new AbortController().signal };
    await handler({ command: "discover", options: { resume: false } }, context);
    await handler({ command: "download", options: { resume: false } }, context);
    await handler({ command: "retry-failed", options: { resume: false } }, context);
    expect(operations.discover).toHaveBeenCalledOnce();
    expect(operations.download).toHaveBeenCalledOnce();
    expect(operations.retryFailed).toHaveBeenCalledOnce();
    expect(operations.close).toHaveBeenCalledTimes(3);
  });

  it("download real no inicia discover implícitamente si falta documents.jsonl", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "pj-cli-empty-"));
    try {
      const error = vi.fn();
      await expect(
        runCli(["download"], undefined, {
          config: { ...config, outputDir },
          writeError: error,
        }),
      ).resolves.toBe(2);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("ejecute discover"));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("retry-failed respeta manifest actual, retryable, resolución y nextRetryAt", () => {
    const request = {
      method: "GET" as const,
      url: "https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/ServletDescarga?uuid=00000000-0000-4000-8000-000000009001",
    };
    const documents = ["11", "12", "13", "14"].map((suffix) => ({
      schemaVersion: 1 as const,
      documentId: `00000000-0000-4000-8000-0000000000${suffix}`,
      partitionId: "supreme",
      sourcePage: 1,
      sourceRow: 0,
      discoveredAt: "2026-07-16T00:00:00.000Z",
      metadata: { list: {}, detail: {}, unknownFields: {} },
      pdf: { state: "pending" as const, request },
    }));
    const failureIds = ["21", "22", "23", "24"].map(
      (suffix) => `00000000-0000-4000-8000-0000000000${suffix}`,
    );
    const failures = failureIds.map((failureId, index) => ({
      schemaVersion: 1 as const,
      failureId,
      phase: "download" as const,
      documentId: documents[index]?.documentId,
      classification: "rate_limit" as const,
      attempts: 3,
      retryable: index !== 2,
      message: "429",
      ...(index === 1 ? { nextRetryAt: "2026-07-17T00:00:00.000Z" } : {}),
      resolution: index === 3 ? ("resolved" as const) : ("open" as const),
      occurredAt: "2026-07-16T00:00:00.000Z",
    }));
    const manifest = new Map(
      documents.map((document, index) => [
        document.documentId,
        {
          schemaVersion: 1 as const,
          eventId: `00000000-0000-4000-8000-0000000000${String(31 + index)}`,
          documentId: document.documentId,
          occurredAt: "2026-07-16T00:00:00.000Z",
          state: "failed" as const,
          request,
          failureId: failureIds[index] ?? failureIds[0] ?? "",
        },
      ]),
    );
    expect(
      selectRetryEligibleDocuments(
        documents,
        failures,
        manifest,
        new Date("2026-07-16T12:00:00.000Z"),
      ).map(({ documentId }) => documentId),
    ).toEqual([documents[0]?.documentId]);
  });
});

describe("resume, señales y exit codes", () => {
  it("acepta checkpoint compatible y rechaza URL, hash o partición incompatibles", () => {
    const checkpoint = {
      schemaVersion: 1 as const,
      source: "pj" as const,
      baseUrl: config.baseUrl,
      queryHash: "a".repeat(64),
      partitionId: "supreme",
      page: 2,
      confirmedRow: 4,
      updatedAt: "2026-07-16T00:00:00.000Z",
    };
    const resumeContext = {
      baseUrl: config.baseUrl,
      queryHash: "a".repeat(64),
      partitionIds: new Set(["supreme", "superior"]),
    };
    expect(() => {
      validateResumeCheckpoint(checkpoint, resumeContext);
    }).not.toThrow();
    expect(() => {
      validateResumeCheckpoint(checkpoint, { ...resumeContext, queryHash: "b".repeat(64) });
    }).toThrow(CliUsageError);
    expect(() => {
      validateResumeCheckpoint(checkpoint, {
        ...resumeContext,
        baseUrl: "https://example.com",
      });
    }).toThrow(CliUsageError);
    expect(() => {
      validateResumeCheckpoint(checkpoint, {
        ...resumeContext,
        partitionIds: new Set(["other"]),
      });
    }).toThrow(CliUsageError);
  });

  it.each(["discover", "download"] as const)(
    "SIGINT durante %s aborta la unidad activa y devuelve 130",
    async (command) => {
      const controller = new AbortController();
      const output = vi.fn();
      const handler = vi.fn<CommandHandler>(
        (_invocation, context): Promise<OperationSummary> =>
          new Promise((resolve) => {
            context.signal.addEventListener(
              "abort",
              () => {
                resolve(summary({ command, stopReason: "interrupted" }));
              },
              { once: true },
            );
          }),
      );
      const execution = runCli([command], handler, {
        config,
        signal: controller.signal,
        writeError: vi.fn(),
        writeOutput: output,
      });
      controller.abort(new CliInterruptedError("SIGINT"));
      await expect(execution).resolves.toBe(130);
      expect(handler.mock.calls[0]?.[1].signal.aborted).toBe(true);
      expect(parseObject(String(output.mock.calls[0]?.[0])).stopReason).toBe("interrupted");
    },
  );

  it("aplica el mapeo de errores accionables", () => {
    expect(exitCodeForError(new CliUsageError("uso"))).toBe(2);
    expect(exitCodeForError(new PreflightError("access", "Perú", "/inicio"))).toBe(3);
    expect(exitCodeForError(new PjStructuralError("estructura"))).toBe(4);
    expect(exitCodeForError(new Error("general"))).toBe(1);
    expect(exitCodeForError(new CliInterruptedError("SIGTERM"))).toBe(143);
  });
});
