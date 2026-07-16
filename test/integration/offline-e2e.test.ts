import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { DiscoveryOrchestrator } from "../../src/core/discovery-orchestrator.js";
import { DownloadManifestStore } from "../../src/core/download-manifest-store.js";
import { reconcileDownloadCoverage } from "../../src/core/download-manifest.js";
import { DownloadWorker } from "../../src/core/download-worker.js";
import { FailureStore } from "../../src/core/failure-store.js";
import type { ControlledResponse } from "../../src/core/http-client.js";
import { HttpRequestError } from "../../src/core/http-errors.js";
import { JsonlStore } from "../../src/core/jsonl-store.js";
import { PdfDownloader, type PdfStreamClient } from "../../src/core/pdf-downloader.js";
import { scrapedDocumentSchema } from "../../src/models/document.js";
import type { PjDiscoveryAdapter } from "../../src/sites/pj/discovery-source.js";
import { PjDiscoverySource } from "../../src/sites/pj/discovery-source.js";
import type { PjListRecord, PjParsedResults } from "../../src/sites/pj/parser.js";
import type { PjCourt } from "../../src/sites/pj/selectors.js";

const uuid = (number: number): string =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const pdfUrl = (number: number): string =>
  `https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/ServletDescarga?uuid=${uuid(number)}`;
const pdfBody = Buffer.from("%PDF-1.7\nflujo e2e offline\n%%EOF\n");

function listRecord(number: number, row: number): PjListRecord {
  return {
    nativeId: uuid(number),
    recordIndex: row,
    row,
    metadata: {
      nroexp: [`EXP-${String(number)}`],
      fechaResolucion: ["16/07/2026"],
    },
    normalized: {
      caseNumber: `EXP-${String(number)}`,
      resolutionDate: "16/07/2026",
    },
    detail: {
      source: `formBuscador:repeat:${String(row)}:j_idt491`,
      nativeId: uuid(number),
      parameters: [["uuid", uuid(number)]],
    },
  };
}

function partitionPage(court: PjCourt, records: PjListRecord[]): PjParsedResults {
  return {
    viewState: `SYNTHETIC_${court.toUpperCase()}`,
    queryTotal: records.length,
    publishedGlobalTotal: 4,
    records,
    pagination: {
      currentPage: 1,
      maxPages: 1,
      pageSize: 10,
      hasNext: false,
      hasLast: false,
      endSignal: "natural_end",
    },
    fingerprint: court === "supreme" ? "a".repeat(64) : "b".repeat(64),
  };
}

class SyntheticPjAdapter implements PjDiscoveryAdapter {
  readonly #pages: Readonly<Record<PjCourt, PjParsedResults>>;
  activeCourt: PjCourt = "supreme";
  enrichments = 0;
  preflights = 0;

  public constructor() {
    this.#pages = {
      supreme: partitionPage("supreme", [listRecord(1, 0), listRecord(2, 1)]),
      superior: partitionPage("superior", [listRecord(3, 0), listRecord(4, 1)]),
    };
  }

  public preflight(): Promise<void> {
    this.preflights += 1;
    return Promise.resolve();
  }

  public bootstrap(): Promise<void> {
    return Promise.resolve();
  }

  public search(options: { court: PjCourt }): Promise<PjParsedResults> {
    this.activeCourt = options.court;
    return Promise.resolve(this.#pages[options.court]);
  }

  public nextPage(): Promise<PjParsedResults> {
    return Promise.reject(new Error("El fixture E2E tiene una página por partición"));
  }

  public goToPage(): Promise<PjParsedResults> {
    return Promise.reject(new Error("El fixture E2E tiene una página por partición"));
  }

  public fetchDetail(record: PjListRecord) {
    this.enrichments += 1;
    const number = Number(record.nativeId.slice(-12));
    return Promise.resolve({
      merged: {
        metadata: {
          list: record.metadata,
          detail: { "Campo exclusivo de detalle": [`detalle-${String(number)}`] },
          unknownFields: {},
        },
        normalized: { ...record.normalized, title: `Resolución ${String(number)}` },
        ...(number === 3
          ? { wordUrl: pdfUrl(103) }
          : { pdf: { method: "GET" as const, url: pdfUrl(number) } }),
      },
    });
  }
}

type PdfStep = { kind: "pdf" } | { kind: "rate_limit"; retryAfterMs: number; attempt: number };

class ScriptedPdfClient implements PdfStreamClient {
  readonly calls: { url: string; documentId: string }[] = [];

  public constructor(private readonly steps: Map<string, PdfStep[]>) {}

  public requestPdfStream(
    url: string | URL,
    documentId: string,
  ): Promise<ControlledResponse<Readable>> {
    this.calls.push({ url: String(url), documentId });
    const step = this.steps.get(documentId)?.shift();
    if (step === undefined) return Promise.reject(new Error(`Red inesperada para ${documentId}`));
    if (step.kind === "rate_limit") {
      return Promise.reject(
        new HttpRequestError("429 agotado en fixture sintético", {
          classification: "rate_limit",
          retryable: true,
          safePath: "/jurisprudenciaweb/ServletDescarga",
          attempt: step.attempt,
          status: 429,
          retryAfterMs: step.retryAfterMs,
        }),
      );
    }
    return Promise.resolve({
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(pdfBody.length),
      },
      data: Readable.from(pdfBody),
      url: String(url),
      attempts: 1,
    });
  }
}

async function lineCount(filePath: string): Promise<number> {
  const content = await readFile(filePath, "utf8");
  return content.trim() === "" ? 0 : content.trim().split("\n").length;
}

describe("E2E offline discover → download → retry-failed", () => {
  it("reconcilia particiones, continúa tras 429, reintenta y es idempotente", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "pj-e2e-"));
    const documentsPath = path.join(outputDir, "data", "documents.jsonl");
    const manifestPath = path.join(outputDir, "data", "download-manifest.jsonl");
    const failuresPath = path.join(outputDir, "data", "failures.jsonl");
    const manifest = new DownloadManifestStore(manifestPath);
    const failures = new FailureStore(failuresPath);
    const discoveredAt = () => new Date("2026-07-16T00:00:00.000Z");

    const firstAdapter = new SyntheticPjAdapter();
    const firstDiscovery = await new DiscoveryOrchestrator<PjListRecord>({
      source: new PjDiscoverySource(firstAdapter, discoveredAt),
      outputDirectory: outputDir,
      baseUrl: "https://jurisprudencia.pj.gob.pe",
      queryHash: "c".repeat(64),
      partitions: ["supreme", "superior"],
      corpusReconciliationPassed: true,
      now: discoveredAt,
    }).run();
    expect(firstDiscovery).toMatchObject({
      termination: "natural_end",
      datasetComplete: true,
      pagesVisited: 2,
      rawMemberships: 4,
      uniqueDocuments: 4,
    });
    expect(firstAdapter).toMatchObject({ preflights: 1, enrichments: 4 });

    const documentsStore = new JsonlStore(documentsPath, scrapedDocumentSchema);
    const documents = (await documentsStore.readAll()).records;
    expect(documents).toHaveLength(4);
    expect(documents[0]?.metadata.detail["Campo exclusivo de detalle"]).toEqual(["detalle-1"]);
    expect(documents[2]?.pdf).toEqual({ state: "no_pdf", reason: "word_only" });
    expect(JSON.stringify(documents.map(({ pdf }) => pdf))).not.toMatch(
      /JSESSIONID|ViewState|cookie/iu,
    );

    let eventId = 500;
    const firstPdfClient = new ScriptedPdfClient(
      new Map([
        [uuid(1), [{ kind: "pdf" }]],
        [uuid(2), [{ kind: "rate_limit", retryAfterMs: 2_000, attempt: 3 }]],
        [uuid(4), [{ kind: "pdf" }]],
      ]),
    );
    const firstWorker = new DownloadWorker({
      downloader: new PdfDownloader(firstPdfClient, {
        outputDir,
        maxPdfBytes: 1024,
        maxStreamRetries: 0,
      }),
      manifestStore: manifest,
      failureStore: failures,
      now: discoveredAt,
      createId: () => uuid(eventId++),
    });
    await expect(firstWorker.run(documents)).resolves.toEqual({
      processed: 4,
      downloaded: 2,
      skipped: 0,
      failed: 1,
      noPdf: 1,
    });
    expect(firstPdfClient.calls.map(({ documentId }) => documentId)).toEqual([
      uuid(1),
      uuid(2),
      uuid(4),
    ]);
    expect((await manifest.currentStates()).get(uuid(2))).toMatchObject({ state: "failed" });

    const retryClient = new ScriptedPdfClient(new Map([[uuid(2), [{ kind: "pdf" }]]]));
    const retryWorker = new DownloadWorker({
      downloader: new PdfDownloader(retryClient, { outputDir, maxPdfBytes: 1024 }),
      manifestStore: manifest,
      failureStore: failures,
      now: discoveredAt,
      createId: () => uuid(eventId++),
    });
    await expect(retryWorker.run(documents, { retryFailedOnly: true })).resolves.toEqual({
      processed: 1,
      downloaded: 1,
      skipped: 0,
      failed: 0,
      noPdf: 0,
    });
    expect(retryClient.calls).toEqual([{ url: pdfUrl(2), documentId: uuid(2) }]);
    expect((await failures.readAll()).records).toEqual([
      expect.objectContaining({
        documentId: uuid(2),
        status: 429,
        retryAfterMs: 2_000,
        resolution: "open",
      }),
      expect.objectContaining({ documentId: uuid(2), resolution: "resolved" }),
    ]);

    const states = await manifest.currentStates();
    expect(reconcileDownloadCoverage(documents, states)).toEqual({
      documents: 4,
      announcesPdf: 3,
      pending: 0,
      downloaded: 3,
      failed: 0,
      noPdf: 1,
      complete: true,
    });
    expect([...states]).toHaveLength(4);

    const documentLines = await lineCount(documentsPath);
    const manifestLines = await lineCount(manifestPath);
    const secondAdapter = new SyntheticPjAdapter();
    const secondDiscovery = await new DiscoveryOrchestrator<PjListRecord>({
      source: new PjDiscoverySource(secondAdapter, discoveredAt),
      outputDirectory: outputDir,
      baseUrl: "https://jurisprudencia.pj.gob.pe",
      queryHash: "c".repeat(64),
      partitions: ["supreme", "superior"],
      corpusReconciliationPassed: true,
      now: discoveredAt,
    }).run();
    expect(secondDiscovery).toMatchObject({
      termination: "natural_end",
      uniqueDocuments: 0,
      duplicates: 4,
    });
    expect(secondAdapter.enrichments).toBe(0);
    expect(await lineCount(documentsPath)).toBe(documentLines);
    expect(await lineCount(manifestPath)).toBe(manifestLines);

    const offlineClient = new ScriptedPdfClient(new Map());
    const secondWorker = new DownloadWorker({
      downloader: new PdfDownloader(offlineClient, { outputDir, maxPdfBytes: 1024 }),
      manifestStore: manifest,
      failureStore: failures,
      now: discoveredAt,
    });
    await expect(secondWorker.run(documents)).resolves.toEqual({
      processed: 4,
      downloaded: 0,
      skipped: 3,
      failed: 0,
      noPdf: 1,
    });
    await expect(secondWorker.run(documents, { retryFailedOnly: true })).resolves.toEqual({
      processed: 0,
      downloaded: 0,
      skipped: 0,
      failed: 0,
      noPdf: 0,
    });
    expect(offlineClient.calls).toEqual([]);
  });
});
