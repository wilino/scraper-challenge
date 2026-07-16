import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  retryEligibleDocumentIds,
  scanDownloadDocuments,
  selectRetryEligibleDocuments,
} from "../../src/cli-operations.js";
import type { ScraperConfig } from "../../src/config/env.js";
import type { CompactDownloadState } from "../../src/core/download-manifest-store.js";
import { DiscoverySessionStateError } from "../../src/core/discovery-types.js";
import { FailureStore } from "../../src/core/failure-store.js";
import { HttpRequestError, PreflightError } from "../../src/core/http-errors.js";
import { JsonlStore } from "../../src/core/jsonl-store.js";
import { scrapedDocumentSchema } from "../../src/models/document.js";
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
    expect(output).toHaveBeenNthCalledWith(1, expect.stringContaining("retry-details"));
    expect(output).toHaveBeenNthCalledWith(2, expect.stringContaining("download"));
  });

  it("parsea opciones operativas y número de pasada", () => {
    expect(
      parseCliArguments([
        "discover",
        "--resume",
        "--limit",
        "25",
        "--max-pages",
        "2",
        "--pass",
        "3",
        "--log-level",
        "debug",
      ]),
    ).toEqual({
      command: "discover",
      options: { resume: true, limit: 25, maxPages: 2, passNumber: 3, logLevel: "debug" },
    });
  });

  it("acepta un selector de partición únicamente para discover", () => {
    expect(parseCliArguments(["discover", "--partition", "superior"])).toEqual({
      command: "discover",
      options: { resume: false, partitionId: "superior" },
    });
    expect(() => parseCliArguments(["download", "--partition", "supreme"])).toThrow(
      /solo puede usarse con discover/,
    );
    expect(() => parseCliArguments(["discover", "--partition", "otra"])).toThrow(
      /requiere supreme, superior o historical-arbitration-lima/,
    );
  });

  it.each([
    ["inexistente"],
    ["discover", "--limit", "0"],
    ["discover", "--limit", "uno"],
    ["discover", "--log-level", "trace"],
    ["download", "--resume"],
    ["retry-failed", "--max-pages", "2"],
    ["retry-details", "--resume"],
    ["download", "--pass", "2"],
    ["download", "--extra"],
    ["discover", "--resume", "--resume"],
  ])("rechaza uso inválido con código 2: %j", async (...arguments_) => {
    await expect(runCli(arguments_, undefined, { config, writeError: vi.fn() })).resolves.toBe(2);
  });
});

describe("delegación y resumen CLI", () => {
  it.each(["discover", "download", "retry-failed", "retry-details"] as const)(
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
      retryDetails: vi.fn(() => Promise.resolve(summary({ command: "retry-details" }))),
      close: vi.fn(() => Promise.resolve()),
    };
    const handler = createCommandHandler(operations);
    const context = { config, signal: new AbortController().signal };
    await handler({ command: "discover", options: { resume: false } }, context);
    await handler({ command: "download", options: { resume: false } }, context);
    await handler({ command: "retry-failed", options: { resume: false } }, context);
    await handler({ command: "retry-details", options: { resume: false } }, context);
    expect(operations.discover).toHaveBeenCalledOnce();
    expect(operations.download).toHaveBeenCalledOnce();
    expect(operations.retryFailed).toHaveBeenCalledOnce();
    expect(operations.retryDetails).toHaveBeenCalledOnce();
    expect(operations.close).toHaveBeenCalledTimes(4);
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

  it("rechaza documents.jsonl sin registros antes de leer manifest o limpiar temporales", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "pj-cli-empty-file-"));
    try {
      await mkdir(path.join(outputDir, "data"));
      await mkdir(path.join(outputDir, "pdf"));
      await writeFile(path.join(outputDir, "data", "documents.jsonl"), " \n\t\n", "utf8");
      await writeFile(
        path.join(outputDir, "data", "download-manifest.jsonl"),
        "manifest corrupto\n",
        "utf8",
      );
      const temporary = path.join(outputDir, "pdf", "pendiente.pdf.part");
      await writeFile(temporary, "no tocar", "utf8");
      await expect(
        runCli(["retry-failed"], undefined, {
          config: { ...config, outputDir },
          writeError: vi.fn(),
        }),
      ).resolves.toBe(2);
      await expect(readFile(temporary, "utf8")).resolves.toBe("no tocar");
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

  it("detiene el scan de download al confirmar un documento más allá del límite", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "pj-cli-limit-"));
    try {
      const filePath = path.join(outputDir, "documents.jsonl");
      const documents = Array.from({ length: 10 }, (_, index) => ({
        schemaVersion: 1 as const,
        documentId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        partitionId: "supreme",
        sourcePage: 1,
        sourceRow: index,
        discoveredAt: "2026-07-16T00:00:00.000Z",
        metadata: { list: {}, detail: {}, unknownFields: {} },
        pdf: { state: "no_pdf" as const, reason: "not_advertised" as const },
      }));
      await writeFile(
        filePath,
        `${documents.map((document) => JSON.stringify(document)).join("\n")}\n`,
        "utf8",
      );
      let visits = 0;
      const result = await scanDownloadDocuments(
        new JsonlStore(filePath, scrapedDocumentSchema),
        undefined,
        () => {
          visits += 1;
          return Promise.resolve(visits < 5);
        },
      );

      expect(visits).toBe(5);
      expect(result).toEqual({
        documents: 6,
        selected: 6,
        partitions: new Map([["supreme", 6]]),
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("propaga aborto durante el scan de documentos de download", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "pj-cli-abort-scan-"));
    try {
      const filePath = path.join(outputDir, "documents.jsonl");
      const documents = Array.from({ length: 100 }, (_, index) => ({
        schemaVersion: 1 as const,
        documentId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        partitionId: "supreme",
        sourcePage: 1,
        sourceRow: index,
        discoveredAt: "2026-07-16T00:00:00.000Z",
        metadata: { list: {}, detail: {}, unknownFields: {} },
        pdf: { state: "no_pdf" as const, reason: "not_advertised" as const },
      }));
      await writeFile(
        filePath,
        `${documents.map((document) => JSON.stringify(document)).join("\n")}\n`,
        "utf8",
      );
      const controller = new AbortController();
      let visits = 0;
      await expect(
        scanDownloadDocuments(
          new JsonlStore(filePath, scrapedDocumentSchema),
          undefined,
          () => {
            visits += 1;
            if (visits === 3) controller.abort(new Error("aborto sintético"));
            return Promise.resolve(true);
          },
          controller.signal,
        ),
      ).rejects.toThrow("aborto sintético");
      expect(visits).toBe(3);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("enlaza retry-failed con el failureId exacto del estado actual del manifest", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "pj-cli-retry-link-"));
    try {
      const documentId = "00000000-0000-4000-8000-000000000501";
      const historicalFailureId = "00000000-0000-4000-8000-000000000601";
      const currentFailureId = "00000000-0000-4000-8000-000000000602";
      const failures = [
        {
          schemaVersion: 1,
          failureId: historicalFailureId,
          phase: "download",
          documentId,
          classification: "network",
          attempts: 1,
          retryable: true,
          message: "histórico elegible",
          resolution: "open",
          occurredAt: "2026-07-16T00:00:00.000Z",
        },
        {
          schemaVersion: 1,
          failureId: currentFailureId,
          phase: "download",
          documentId,
          classification: "rate_limit",
          attempts: 2,
          retryable: true,
          message: "actual con espera",
          nextRetryAt: "2026-07-17T00:00:00.000Z",
          resolution: "open",
          occurredAt: "2026-07-16T00:01:00.000Z",
        },
      ];
      const failurePath = path.join(outputDir, "failures.jsonl");
      await writeFile(
        failurePath,
        `${failures.map((failure) => JSON.stringify(failure)).join("\n")}\n`,
        "utf8",
      );
      const store = new FailureStore(failurePath);
      const states = new Map<string, CompactDownloadState>([
        [documentId, { state: "failed", failureId: currentFailureId }],
      ]);

      const beforeCurrentIsDue = await store.retryEligibleFailureIds(
        new Date("2026-07-16T12:00:00.000Z"),
      );
      expect(beforeCurrentIsDue).toEqual(new Set([historicalFailureId]));
      expect(retryEligibleDocumentIds(states, beforeCurrentIsDue)).toEqual(new Set());

      const afterCurrentIsDue = await store.retryEligibleFailureIds(
        new Date("2026-07-17T01:00:00.000Z"),
      );
      expect(retryEligibleDocumentIds(states, afterCurrentIsDue)).toEqual(new Set([documentId]));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
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
    expect(exitCodeForError(new DiscoverySessionStateError("sesión irrecuperable"))).toBe(4);
    expect(exitCodeForError(new Error("general"))).toBe(1);
    expect(exitCodeForError(new CliInterruptedError("SIGTERM"))).toBe(143);
  });

  it("informa diagnóstico HTTP seguro sin URL completa ni body", async () => {
    const writeError = vi.fn();
    const handler = vi.fn<CommandHandler>(() =>
      Promise.reject(
        new HttpRequestError("PJ respondió con estado transitorio 500", {
          classification: "http_transient",
          retryable: true,
          safePath: "/jurisprudenciaweb/faces/page/resultado.xhtml",
          attempt: 6,
          status: 500,
        }),
      ),
    );

    await expect(runCli(["discover"], handler, { config, writeError })).resolves.toBe(1);
    expect(writeError).toHaveBeenCalledWith(
      "PJ respondió con estado transitorio 500 [http_transient; HTTP-500; /jurisprudenciaweb/faces/page/resultado.xhtml; intento 6]",
    );
  });
});
