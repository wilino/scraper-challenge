import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DetailRetryService } from "../../src/core/detail-retry-service.js";
import type { DiscoveryPage, DiscoverySource } from "../../src/core/discovery-types.js";
import { FailureStore } from "../../src/core/failure-store.js";
import type { ScrapedDocument } from "../../src/models/document.js";

const documentId = "00000000-0000-4000-8000-000000000501";
const eventId = "00000000-0000-4000-8000-000000000502";
const failureId = "00000000-0000-4000-8000-000000000503";
const now = new Date("2026-07-16T12:00:00.000Z");
const temporaryDirectories: string[] = [];

interface TestRecord {
  nativeId: string;
}

function page(): DiscoveryPage<TestRecord> {
  return {
    partitionId: "supreme",
    parsed: {
      viewState: "ephemeral-test-only",
      queryTotal: 1,
      publishedGlobalTotal: 1,
      records: [{ nativeId: documentId }],
      pagination: {
        currentPage: 2,
        maxPages: 2,
        pageSize: 10,
        hasNext: false,
        hasLast: false,
        endSignal: "natural_end",
      },
      fingerprint: "page-2",
    },
  };
}

function document(): ScrapedDocument {
  return {
    schemaVersion: 1,
    documentId,
    partitionId: "supreme",
    sourcePage: 2,
    sourceRow: 0,
    discoveredAt: now.toISOString(),
    metadata: { list: {}, detail: { Sala: ["Suprema"] }, unknownFields: {} },
    pdf: { state: "no_pdf", reason: "not_advertised" },
  };
}

async function outputDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pj-detail-retry-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function seedFailure(
  directory: string,
  nextRetryAt?: string,
  retryable = true,
): Promise<void> {
  await new FailureStore(path.join(directory, "data", "failures.jsonl")).append({
    schemaVersion: 1,
    failureId,
    phase: "detail",
    partitionId: "supreme",
    documentId,
    page: 2,
    classification: "network",
    attempts: 1,
    retryable,
    message: "Detalle PJ incompleto (HttpRequestError)",
    ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
    resolution: "open",
    occurredAt: "2026-07-16T11:00:00.000Z",
  });
}

function source(enrich = vi.fn(() => Promise.resolve(document()))): DiscoverySource<TestRecord> {
  return {
    preflight: vi.fn(() => Promise.resolve()),
    openPartition: vi.fn(() => Promise.resolve(page())),
    enrichRecord: enrich,
    nextPage: vi.fn(() => Promise.resolve(null)),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DetailRetryService", () => {
  it("reintenta un detalle estructural abierto tras una corrección de código", async () => {
    const directory = await outputDirectory();
    await seedFailure(directory, undefined, false);

    await expect(
      new DetailRetryService({
        source: source(),
        outputDirectory: directory,
        now: () => now,
      }).run(),
    ).resolves.toMatchObject({ selected: 1, resolved: 1, stillFailed: 0, remaining: 0 });
  });

  it("reconstruye la sesión, persiste una vez y resuelve el pendiente lógico", async () => {
    const directory = await outputDirectory();
    await seedFailure(directory);
    const adapter = source();
    const service = new DetailRetryService({
      source: adapter,
      outputDirectory: directory,
      now: () => now,
      uuid: () => eventId,
    });

    await expect(service.run()).resolves.toMatchObject({
      selected: 1,
      resolved: 1,
      stillFailed: 0,
      notEligible: 0,
    });
    expect(
      await new FailureStore(path.join(directory, "data", "failures.jsonl")).currentFailures(
        "detail",
      ),
    ).toEqual([]);

    await expect(service.run()).resolves.toMatchObject({ selected: 0, resolved: 0 });
    expect(
      (await readFile(path.join(directory, "data", "documents.jsonl"), "utf8")).trim().split("\n"),
    ).toHaveLength(1);
    expect(
      (await readFile(path.join(directory, "data", "download-manifest.jsonl"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(1);
  });

  it("no intenta pendientes cuyo nextRetryAt aún no venció", async () => {
    const directory = await outputDirectory();
    await seedFailure(directory, "2026-07-16T13:00:00.000Z");
    const adapter = source();
    const result = await new DetailRetryService({
      source: adapter,
      outputDirectory: directory,
      now: () => now,
    }).run();

    expect(result).toMatchObject({ selected: 0, resolved: 0, notEligible: 1 });
  });

  it("un descriptor permanente permanece abierto aunque el comando dirigido lo intente", async () => {
    const directory = await outputDirectory();
    await seedFailure(directory);
    const missingSource = source();
    missingSource.openPartition = vi.fn(() =>
      Promise.resolve({ ...page(), parsed: { ...page().parsed, records: [] } }),
    );
    const service = new DetailRetryService({
      source: missingSource,
      outputDirectory: directory,
      now: () => now,
    });

    await expect(service.run()).resolves.toMatchObject({ selected: 1, stillFailed: 1 });
    const [failure] = await new FailureStore(
      path.join(directory, "data", "failures.jsonl"),
    ).currentFailures("detail");
    expect(failure).toMatchObject({
      failureId,
      classification: "structural",
      retryable: false,
      attempts: 2,
      resolution: "open",
    });
  });

  it("un abort no escribe documento, manifest ni resolución", async () => {
    const directory = await outputDirectory();
    await seedFailure(directory);
    const controller = new AbortController();
    const aborting = source(
      vi.fn(() => {
        controller.abort();
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }),
    );
    const service = new DetailRetryService({ source: aborting, outputDirectory: directory });

    await expect(service.run({ signal: controller.signal })).rejects.toThrow(/aborted/i);
    expect(
      await new FailureStore(path.join(directory, "data", "failures.jsonl")).currentFailures(
        "detail",
      ),
    ).toHaveLength(1);
    await expect(
      readFile(path.join(directory, "data", "documents.jsonl"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("el descriptor persistido no contiene estado JSF, cookies, request ni URL", async () => {
    const directory = await outputDirectory();
    await seedFailure(directory);
    const [failure] = await new FailureStore(
      path.join(directory, "data", "failures.jsonl"),
    ).currentFailures("detail");
    expect(failure).not.toHaveProperty("request");
    expect(JSON.stringify(failure)).not.toMatch(/ViewState|cookie|https?:/i);
  });
});
