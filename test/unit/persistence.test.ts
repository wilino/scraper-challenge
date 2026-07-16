import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { CheckpointStore } from "../../src/core/checkpoint-store.js";
import { DownloadManifestStore } from "../../src/core/download-manifest-store.js";
import { FailureStore } from "../../src/core/failure-store.js";
import { JsonlCorruptionError, JsonlStore } from "../../src/core/jsonl-store.js";
import { PagePersistence } from "../../src/core/page-persistence.js";
import type { Checkpoint } from "../../src/models/checkpoint.js";
import type { ScrapedDocument } from "../../src/models/document.js";
import type { ScrapeFailure } from "../../src/models/failure.js";

const uuid = (number: number): string =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

const checkpoint = (page = 1): Checkpoint => ({
  schemaVersion: 1,
  source: "pj",
  baseUrl: "https://jurisprudencia.pj.gob.pe",
  queryHash: "a".repeat(64),
  partitionId: "supreme",
  page,
  confirmedRow: 2,
  updatedAt: "2026-07-16T00:00:00.000Z",
});

const document = (number: number): ScrapedDocument => ({
  schemaVersion: 1,
  documentId: uuid(number),
  partitionId: "supreme",
  sourcePage: 1,
  sourceRow: number,
  discoveredAt: "2026-07-16T00:00:00.000Z",
  metadata: { list: {}, detail: {}, unknownFields: {} },
  pdf: { state: "no_pdf", reason: "not_advertised" },
});

describe("persistencia append-only", () => {
  it("serializa appends concurrentes sin intercalar líneas", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pj-jsonl-"));
    const filePath = path.join(root, "events.jsonl");
    const store = new JsonlStore(filePath, z.object({ value: z.number().int() }));
    await Promise.all(Array.from({ length: 25 }, (_, value) => store.append({ value })));
    const result = await store.readAll();
    expect(result.truncatedLastLine).toBe(false);
    expect(result.records).toHaveLength(25);
    expect(new Set(result.records.map(({ value }) => value)).size).toBe(25);
  });

  it("tolera solo una última línea truncada y falla ante corrupción intermedia", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pj-jsonl-"));
    const filePath = path.join(root, "events.jsonl");
    const store = new JsonlStore(filePath, z.object({ value: z.number() }));
    await writeFile(filePath, '{"value":1}\n{"value":', "utf8");
    await expect(store.readAll()).resolves.toEqual({
      records: [{ value: 1 }],
      truncatedLastLine: true,
    });
    await writeFile(filePath, '{"value":1}\nno-json\n{"value":2}\n', "utf8");
    await expect(store.readAll()).rejects.toBeInstanceOf(JsonlCorruptionError);
  });

  it("scan visita registros validados con línea y conserva la semántica de truncamiento", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pj-jsonl-"));
    const filePath = path.join(root, "events.jsonl");
    const store = new JsonlStore(filePath, z.object({ value: z.number() }));
    await writeFile(filePath, '\n{"value":1}\r\n{"value":2}\n{"value":', "utf8");
    const visited: { value: number; line: number }[] = [];

    await expect(
      store.scan(async (record, line) => {
        await Promise.resolve();
        visited.push({ value: record.value, line });
      }),
    ).resolves.toEqual({ records: 2, truncatedLastLine: true });
    expect(visited).toEqual([
      { value: 1, line: 2 },
      { value: 2, line: 3 },
    ]);

    await writeFile(filePath, '{"value":1}\nno-json\n{"value":2}', "utf8");
    await expect(store.scan(() => undefined)).rejects.toBeInstanceOf(JsonlCorruptionError);

    await writeFile(filePath, '{"value":1}\n{"value":"inválido"}', "utf8");
    await expect(store.scan(() => undefined)).resolves.toEqual({
      records: 1,
      truncatedLastLine: true,
    });
    await appendFile(filePath, "\n", "utf8");
    await expect(store.scan(() => undefined)).rejects.toBeInstanceOf(JsonlCorruptionError);
  });

  it("scan propaga errores del visitor incluso en una línea final sin salto", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pj-jsonl-"));
    const filePath = path.join(root, "events.jsonl");
    const store = new JsonlStore(filePath, z.object({ value: z.number() }));
    await writeFile(filePath, '{"value":1}', "utf8");

    await expect(
      store.scan(() => {
        throw new Error("visitor detenido");
      }),
    ).rejects.toThrow("visitor detenido");
  });

  it("scan consume un volumen sintético incrementalmente y con backpressure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pj-jsonl-"));
    const filePath = path.join(root, "events.jsonl");
    const total = 10_000;
    let parsed = 0;
    const schema = z.object({ value: z.number().int() }).superRefine(() => {
      parsed += 1;
    });
    const store = new JsonlStore(filePath, schema);
    await writeFile(
      filePath,
      `${Array.from({ length: total }, (_, value) => JSON.stringify({ value })).join("\n")}\n`,
      "utf8",
    );
    let visited = 0;
    let activeVisitors = 0;
    let maximumActiveVisitors = 0;

    const result = await store.scan(async ({ value }) => {
      if (visited === 0) expect(parsed).toBeLessThan(total);
      activeVisitors += 1;
      maximumActiveVisitors = Math.max(maximumActiveVisitors, activeVisitors);
      await Promise.resolve();
      expect(value).toBe(visited);
      visited += 1;
      activeVisitors -= 1;
    });

    expect(result).toEqual({ records: total, truncatedLastLine: false });
    expect(visited).toBe(total);
    expect(maximumActiveVisitors).toBe(1);
  });

  it("reemplaza checkpoint atómicamente y rechaza contenido incompatible", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pj-checkpoint-"));
    const filePath = path.join(root, "state", "checkpoint.json");
    const store = new CheckpointStore(filePath);
    await store.save(checkpoint());
    await store.save(checkpoint(2));
    await expect(store.load()).resolves.toMatchObject({ page: 2, schemaVersion: 1 });
    await writeFile(filePath, '{"schemaVersion":99}', "utf8");
    await expect(store.load()).rejects.toThrow(/reinicie explícitamente o migre/);
  });

  it("reanuda sin duplicar tres documentos y agrega un cuarto", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pj-resume-"));
    const first = new PagePersistence(root);
    await first.initialize();
    await expect(
      first.confirmDocuments([document(1), document(2), document(3)], checkpoint()),
    ).resolves.toBe(3);

    const restarted = new PagePersistence(root);
    await restarted.initialize();
    await expect(
      restarted.confirmDocuments(
        [document(1), document(2), document(3), document(4)],
        checkpoint(2),
      ),
    ).resolves.toBe(1);

    const content = await readFile(path.join(root, "data", "documents.jsonl"), "utf8");
    expect(content.trim().split("\n")).toHaveLength(4);
    expect(await restarted.loadCheckpoint()).toMatchObject({ page: 2 });
  });

  it("no confirma checkpoint cuando falla la persistencia de un documento", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pj-order-"));
    const persistence = new PagePersistence(root);
    await persistence.initialize();
    await expect(
      persistence.confirmDocuments([{ ...document(1), documentId: "no-es-uuid" }], checkpoint()),
    ).rejects.toThrow();
    await expect(persistence.loadCheckpoint()).resolves.toBeNull();
  });

  it("acepta una línea final válida aunque no tenga salto final", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pj-jsonl-"));
    const filePath = path.join(root, "events.jsonl");
    const store = new JsonlStore(filePath, z.object({ value: z.number() }));
    await writeFile(filePath, '{"value":1}', "utf8");
    await expect(store.readAll()).resolves.toEqual({
      records: [{ value: 1 }],
      truncatedLastLine: false,
    });
    await appendFile(filePath, "\n", "utf8");
  });

  it("deriva el estado actual del último evento del manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pj-manifest-"));
    const store = new DownloadManifestStore(path.join(root, "download-manifest.jsonl"));
    const request = {
      method: "GET" as const,
      url: `https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/ServletDescarga?uuid=${uuid(1)}`,
    };
    await store.append({
      schemaVersion: 1,
      eventId: uuid(101),
      documentId: uuid(1),
      occurredAt: "2026-07-16T00:00:00.000Z",
      state: "pending",
      request,
    });
    await store.append({
      schemaVersion: 1,
      eventId: uuid(102),
      documentId: uuid(1),
      occurredAt: "2026-07-16T00:01:00.000Z",
      state: "failed",
      request,
      failureId: uuid(201),
    });
    expect((await store.currentStates()).get(uuid(1))?.state).toBe("failed");
    await expect(store.documentIds()).resolves.toEqual(new Set([uuid(1)]));
  });

  it("indexa el ledger de fallos una vez y resuelve consultas masivas en memoria", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pj-failures-"));
    const filePath = path.join(root, "failures.jsonl");
    const failure: ScrapeFailure = {
      schemaVersion: 1,
      failureId: uuid(101),
      phase: "download",
      partitionId: "supreme",
      documentId: uuid(1),
      page: 1,
      classification: "network",
      attempts: 1,
      retryable: true,
      message: "fallo sintético",
      resolution: "open",
      occurredAt: "2026-07-16T00:00:00.000Z",
    };
    await writeFile(filePath, `${JSON.stringify(failure)}\n`, "utf8");
    const store = new FailureStore(filePath);
    const scan = vi.spyOn(store, "scan");
    await expect(
      store.retryEligibleFailureIds(new Date("2026-07-16T00:30:00.000Z")),
    ).resolves.toEqual(new Set([uuid(101)]));

    for (let index = 2; index <= 1_000; index += 1) {
      await expect(
        store.resolveOpenForDocument("download", uuid(index), "2026-07-16T01:00:00.000Z"),
      ).resolves.toBe(0);
    }
    await expect(
      store.resolveOpenForDocument("download", uuid(1), "2026-07-16T01:00:00.000Z"),
    ).resolves.toBe(1);
    await expect(
      store.resolveOpenForDocument("download", uuid(1), "2026-07-16T02:00:00.000Z"),
    ).resolves.toBe(0);
    await expect(
      store.retryEligibleFailureIds(new Date("2026-07-16T02:00:00.000Z")),
    ).resolves.toEqual(new Set());
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("comparte una sola inicialización del ledger entre operaciones concurrentes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pj-failures-race-"));
    const filePath = path.join(root, "failures.jsonl");
    const first: ScrapeFailure = {
      schemaVersion: 1,
      failureId: uuid(301),
      phase: "download",
      documentId: uuid(1),
      classification: "network",
      attempts: 1,
      retryable: true,
      message: "primero",
      resolution: "open",
      occurredAt: "2026-07-16T00:00:00.000Z",
    };
    const second: ScrapeFailure = {
      ...first,
      failureId: uuid(302),
      documentId: uuid(2),
      message: "segundo",
    };
    await writeFile(filePath, `${JSON.stringify(first)}\n`, "utf8");
    const store = new FailureStore(filePath);
    const scan = vi.spyOn(store, "scan");

    const [eligible, resolved, appended] = await Promise.all([
      store.retryEligibleFailureIds(new Date("2026-07-16T01:00:00.000Z")),
      store.resolveOpenForDocument("download", uuid(999), "2026-07-16T01:00:00.000Z"),
      store.append(second),
    ]);
    expect(eligible).toEqual(new Set([first.failureId]));
    expect(resolved).toBe(0);
    expect(appended).toBeUndefined();
    expect(scan).toHaveBeenCalledTimes(1);
    await expect(
      store.retryEligibleFailureIds(new Date("2026-07-16T02:00:00.000Z")),
    ).resolves.toEqual(new Set([first.failureId, second.failureId]));
  });

  it("descarta del índice miles de fallos ya resueltos y conserva solo los abiertos", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pj-failures-resolved-"));
    const filePath = path.join(root, "failures.jsonl");
    const total = 5_000;
    const lines: string[] = [];
    for (let index = 1; index <= total; index += 1) {
      const open: ScrapeFailure = {
        schemaVersion: 1,
        failureId: uuid(index),
        phase: "download",
        documentId: uuid(index + total),
        classification: "network",
        attempts: 1,
        retryable: true,
        message: "transitorio",
        resolution: "open",
        occurredAt: "2026-07-16T00:00:00.000Z",
      };
      lines.push(JSON.stringify(open));
      lines.push(
        JSON.stringify({
          ...open,
          resolution: "resolved",
          resolvedAt: "2026-07-16T00:01:00.000Z",
        }),
      );
    }
    const remaining: ScrapeFailure = {
      schemaVersion: 1,
      failureId: uuid(total + 20_000),
      phase: "download",
      documentId: uuid(total + 30_000),
      classification: "network",
      attempts: 1,
      retryable: true,
      message: "permanece abierto",
      resolution: "open",
      occurredAt: "2026-07-16T00:02:00.000Z",
    };
    lines.push(JSON.stringify(remaining));
    await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");

    const store = new FailureStore(filePath);
    await expect(
      store.retryEligibleFailureIds(new Date("2026-07-16T01:00:00.000Z")),
    ).resolves.toEqual(new Set([remaining.failureId]));
    await expect(store.resolve(uuid(1), "2026-07-16T02:00:00.000Z")).resolves.toBeUndefined();
  });
});
