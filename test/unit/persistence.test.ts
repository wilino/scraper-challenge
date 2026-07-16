import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import { CheckpointStore } from "../../src/core/checkpoint-store.js";
import { DownloadManifestStore } from "../../src/core/download-manifest-store.js";
import { JsonlCorruptionError, JsonlStore } from "../../src/core/jsonl-store.js";
import { PagePersistence } from "../../src/core/page-persistence.js";
import type { Checkpoint } from "../../src/models/checkpoint.js";
import type { ScrapedDocument } from "../../src/models/document.js";

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
  });
});
