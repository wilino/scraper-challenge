import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { DownloadManifestStore } from "../../src/core/download-manifest-store.js";
import { reconcileDownloadCoverage } from "../../src/core/download-manifest.js";
import { DownloadWorker } from "../../src/core/download-worker.js";
import { FailureStore } from "../../src/core/failure-store.js";
import type { ControlledResponse } from "../../src/core/http-client.js";
import { HttpRequestError } from "../../src/core/http-errors.js";
import {
  PdfDownloadError,
  PdfDownloader,
  type PdfStreamClient,
} from "../../src/core/pdf-downloader.js";
import type { ScrapedDocument } from "../../src/models/document.js";
import type { DownloadManifestEvent } from "../../src/models/download-manifest.js";
import { pdfFileName, resolvePdfPath } from "../../src/utils/file-names.js";

const uuid = (number: number): string =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const pdfUrl = (number: number): string =>
  `https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/ServletDescarga?uuid=${uuid(number)}`;
const validPdf = Buffer.from("%PDF-1.7\nobjeto de prueba\n%%EOF\n");

function document(number: number, pdf = true): ScrapedDocument {
  return {
    schemaVersion: 1,
    documentId: uuid(number),
    partitionId: "supreme",
    sourcePage: 2,
    sourceRow: number,
    discoveredAt: "2026-07-16T00:00:00.000Z",
    resolutionDate: "16/07/2026",
    resolutionNumber: `Resolución ../ ${String(number)}`,
    metadata: { list: {}, detail: {}, unknownFields: {} },
    pdf: pdf
      ? { state: "pending", request: { method: "GET", url: pdfUrl(number) } }
      : { state: "no_pdf", reason: "not_advertised" },
  };
}

type ResponseFactory = () => ControlledResponse<Readable> | Promise<ControlledResponse<Readable>>;

class QueueClient implements PdfStreamClient {
  public calls = 0;

  public constructor(private readonly factories: ResponseFactory[]) {}

  public async requestPdfStream(): Promise<ControlledResponse<Readable>> {
    const factory = this.factories[this.calls];
    this.calls += 1;
    if (factory === undefined) throw new Error("Respuesta de prueba no configurada");
    return await factory();
  }
}

function response(
  body: Buffer,
  contentType = "application/octet-stream",
): ControlledResponse<Readable> {
  return {
    status: 200,
    headers: { "content-type": contentType, "content-length": String(body.length) },
    data: Readable.from(body),
    url: pdfUrl(1),
    attempts: 1,
  };
}

async function root(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "pj-pdf-"));
}

describe("pipeline PDF seguro", () => {
  it.each(["application/octet-stream", "application/pdf"])(
    "acepta PDF firmado con content-type %s y calcula hash por streaming",
    async (contentType) => {
      const outputDir = await root();
      const client = new QueueClient([() => response(validPdf, contentType)]);
      const downloader = new PdfDownloader(client, { outputDir, maxPdfBytes: 1024 });
      await downloader.initialize();
      const result = await downloader.download(document(1));
      expect(result).toMatchObject({ state: "downloaded", bytes: validPdf.length, attempts: 1 });
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(await readFile(path.join(outputDir, result.relativePath), "utf8")).toBe(
        validPdf.toString("utf8"),
      );
    },
  );

  it.each([
    ["HTML 200", Buffer.from("<html>login</html>"), "PDF_INVALID_SIGNATURE"],
    ["vacío", Buffer.alloc(0), "PDF_EMPTY"],
    ["menor al mínimo", Buffer.from("%PDF-"), "PDF_TOO_SMALL"],
    ["sobre MAX_PDF_BYTES", Buffer.concat([validPdf, Buffer.alloc(100)]), "PDF_TOO_LARGE"],
  ])("rechaza %s y elimina el temporal", async (_label, body, code) => {
    const outputDir = await root();
    const client = new QueueClient([() => response(body)]);
    const downloader = new PdfDownloader(client, {
      outputDir,
      minPdfBytes: 10,
      maxPdfBytes: 64,
      maxStreamRetries: 0,
    });
    await downloader.initialize();
    await expect(downloader.download(document(1))).rejects.toMatchObject({ code });
    expect(
      (await readdir(path.join(outputDir, "pdf"))).filter((name) => name.endsWith(".part")),
    ).toEqual([]);
  });

  it("reintenta un stream cerrado prematuramente y termina sin .part", async () => {
    const outputDir = await root();
    const broken = new Readable({
      read() {
        this.push(Buffer.from("%PDF-1.7\n"));
        this.destroy(Object.assign(new Error("premature"), { code: "ERR_STREAM_PREMATURE_CLOSE" }));
      },
    });
    const client = new QueueClient([
      () => ({ ...response(validPdf), data: broken, headers: {} }),
      () => response(validPdf),
    ]);
    const downloader = new PdfDownloader(client, {
      outputDir,
      maxPdfBytes: 1024,
      retryBaseMs: 1,
      sleep: () => Promise.resolve(),
    });
    await downloader.initialize();
    await expect(downloader.download(document(1))).resolves.toMatchObject({ state: "downloaded" });
    expect(client.calls).toBe(2);
    expect(
      (await readdir(path.join(outputDir, "pdf"))).some((name) => name.endsWith(".part")),
    ).toBe(false);
  });

  it("omite sin red solo cuando archivo, firma, tamaño y hash coinciden", async () => {
    const outputDir = await root();
    const firstClient = new QueueClient([() => response(validPdf)]);
    const firstDownloader = new PdfDownloader(firstClient, { outputDir, maxPdfBytes: 1024 });
    await firstDownloader.initialize();
    const first = await firstDownloader.download(document(1));
    const event: DownloadManifestEvent = {
      schemaVersion: 1,
      eventId: uuid(101),
      documentId: uuid(1),
      occurredAt: "2026-07-16T00:00:00.000Z",
      state: "downloaded",
      request: { method: "GET", url: pdfUrl(1) },
      relativePath: first.relativePath,
      sha256: first.sha256,
      bytes: first.bytes,
      effectiveUrl: first.effectiveUrl,
    };
    const offline = new QueueClient([]);
    const resumed = new PdfDownloader(offline, { outputDir, maxPdfBytes: 1024 });
    await expect(resumed.download(document(1), event)).resolves.toMatchObject({ state: "skipped" });
    expect(offline.calls).toBe(0);

    await writeFile(path.join(outputDir, first.relativePath), "%PDF-corrupto", "utf8");
    const repairClient = new QueueClient([() => response(validPdf)]);
    await expect(
      new PdfDownloader(repairClient, { outputDir, maxPdfBytes: 1024 }).download(
        document(1),
        event,
      ),
    ).resolves.toMatchObject({ state: "downloaded" });
    expect(repairClient.calls).toBe(1);
  });

  it("limpia huérfanos al iniciar y genera nombres deterministas sin traversal", async () => {
    const outputDir = await root();
    const pdfDir = path.join(outputDir, "pdf");
    await writeFile(path.join(outputDir, "keep.txt"), "keep", "utf8");
    await mkdir(pdfDir);
    await writeFile(path.join(pdfDir, "huerfano.pdf.part"), "x", "utf8");
    const downloader = new PdfDownloader(new QueueClient([]), { outputDir, maxPdfBytes: 1024 });
    await downloader.initialize();
    expect(await readdir(pdfDir)).toEqual([]);
    const name = pdfFileName(document(1));
    expect(name).toContain(`${uuid(1)}__16-07-2026__Resolución-1.pdf`);
    expect(resolvePdfPath(outputDir, name).startsWith(pdfDir)).toBe(true);
    expect(() => resolvePdfPath(outputDir, "../escape.pdf")).toThrow(/escapa/u);
  });

  it("rechaza un directorio PDF enlazado fuera de OUTPUT_DIR", async () => {
    const outputDir = await root();
    const external = await root();
    await symlink(external, path.join(outputDir, "pdf"), "dir");
    const downloader = new PdfDownloader(new QueueClient([]), { outputDir, maxPdfBytes: 1024 });
    await expect(downloader.initialize()).rejects.toThrow(/enlace simbólico/u);
  });

  it("rechaza descriptor con parámetros extra antes de hacer red", async () => {
    const outputDir = await root();
    const unsafe = document(1);
    if (unsafe.pdf.state === "pending") unsafe.pdf.request.url = `${pdfUrl(1)}&extra=1`;
    const client = new QueueClient([]);
    await expect(
      new PdfDownloader(client, { outputDir, maxPdfBytes: 1024 }).download(unsafe),
    ).rejects.toMatchObject({ classification: "security" });
    expect(client.calls).toBe(0);
  });

  it("continúa tras un 429 agotado, registra descriptor y procesa el siguiente", async () => {
    const outputDir = await root();
    const client = new QueueClient([
      () => {
        throw new HttpRequestError("rate limit agotado", {
          classification: "rate_limit",
          retryable: true,
          safePath: "/jurisprudenciaweb/ServletDescarga",
          attempt: 3,
          status: 429,
          retryAfterMs: 1000,
        });
      },
      () => ({ ...response(validPdf), url: pdfUrl(2) }),
      () => response(validPdf),
    ]);
    const downloader = new PdfDownloader(client, {
      outputDir,
      maxPdfBytes: 1024,
      maxStreamRetries: 0,
    });
    const manifestStore = new DownloadManifestStore(path.join(outputDir, "manifest.jsonl"));
    const failureStore = new FailureStore(path.join(outputDir, "failures.jsonl"));
    let id = 500;
    const worker = new DownloadWorker({
      downloader,
      manifestStore,
      failureStore,
      now: () => new Date("2026-07-16T00:00:00.000Z"),
      createId: () => uuid(id++),
    });
    await expect(worker.run([document(1), document(2), document(3, false)])).resolves.toEqual({
      processed: 3,
      downloaded: 1,
      skipped: 0,
      failed: 1,
      noPdf: 1,
    });
    const failure = (await failureStore.readAll()).records[0];
    expect(failure).toMatchObject({
      documentId: uuid(1),
      request: { url: pdfUrl(1) },
      classification: "rate_limit",
      attempts: 3,
      status: 429,
      retryAfterMs: 1000,
      resolution: "open",
    });
    const states = await manifestStore.currentStates();
    expect(
      reconcileDownloadCoverage([document(1), document(2), document(3, false)], states),
    ).toEqual({
      documents: 3,
      announcesPdf: 2,
      pending: 0,
      downloaded: 1,
      failed: 1,
      noPdf: 1,
      complete: true,
    });

    await expect(
      worker.run([document(1), document(2), document(3, false)], { retryFailedOnly: true }),
    ).resolves.toEqual({
      processed: 1,
      downloaded: 1,
      skipped: 0,
      failed: 0,
      noPdf: 0,
    });
    expect((await failureStore.readAll()).records.at(-1)).toMatchObject({
      failureId: failure?.failureId,
      resolution: "resolved",
      resolvedAt: "2026-07-16T00:00:00.000Z",
    });
    expect((await manifestStore.currentStates()).get(uuid(1))?.state).toBe("downloaded");
  });

  it("consume documentos por scanner sin materializar el corpus completo", async () => {
    const outputDir = await root();
    const manifestPath = path.join(outputDir, "manifest.jsonl");
    const total = 10_000;
    await writeFile(
      manifestPath,
      `${Array.from({ length: total }, (_, index) =>
        JSON.stringify({
          schemaVersion: 1,
          eventId: uuid(index + 20_000),
          documentId: uuid(index + 1),
          occurredAt: "2026-07-16T00:00:00.000Z",
          state: "pending",
          request: { method: "GET", url: pdfUrl(index + 1) },
        }),
      ).join("\n")}\n`,
      "utf8",
    );
    const worker = new DownloadWorker({
      downloader: new PdfDownloader(new QueueClient([]), { outputDir, maxPdfBytes: 1024 }),
      manifestStore: new DownloadManifestStore(manifestPath),
      failureStore: new FailureStore(path.join(outputDir, "failures.jsonl")),
    });
    let generated = 0;

    await expect(
      worker.runStreaming(
        async (visit) => {
          for (let index = 1; index <= total; index += 1) {
            generated += 1;
            if (!(await visit(document(index)))) break;
          }
        },
        { retryFailedOnly: true },
      ),
    ).resolves.toEqual({
      processed: 0,
      downloaded: 0,
      skipped: 0,
      failed: 0,
      noPdf: 0,
    });
    expect(generated).toBe(total);
  });

  it("reutiliza el índice compacto precargado sin volver a escanear el manifest", async () => {
    const outputDir = await root();
    const manifestStore = new DownloadManifestStore(path.join(outputDir, "manifest.jsonl"));
    const compactStates = vi.spyOn(manifestStore, "compactStates");
    const states = new Map([[uuid(1), "no_pdf" as const]]);
    const worker = new DownloadWorker({
      downloader: new PdfDownloader(new QueueClient([]), { outputDir, maxPdfBytes: 1024 }),
      manifestStore,
      failureStore: new FailureStore(path.join(outputDir, "failures.jsonl")),
      manifestStates: states,
    });

    await expect(worker.run([document(1, false)])).resolves.toEqual({
      processed: 1,
      downloaded: 0,
      skipped: 0,
      failed: 0,
      noPdf: 1,
    });
    expect(compactStates).not.toHaveBeenCalled();
  });

  it("repara manifest failed aunque su failureId ya estuviera resuelto por una caída", async () => {
    const outputDir = await root();
    const manifestPath = path.join(outputDir, "manifest.jsonl");
    const failurePath = path.join(outputDir, "failures.jsonl");
    const failureId = uuid(801);
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        eventId: uuid(802),
        documentId: uuid(1),
        occurredAt: "2026-07-16T00:00:00.000Z",
        state: "failed",
        request: { method: "GET", url: pdfUrl(1) },
        failureId,
      })}\n`,
      "utf8",
    );
    await writeFile(
      failurePath,
      `${JSON.stringify({
        schemaVersion: 1,
        failureId,
        phase: "download",
        documentId: uuid(1),
        classification: "network",
        attempts: 1,
        retryable: true,
        message: "ya resuelto antes de la caída",
        resolution: "resolved",
        occurredAt: "2026-07-16T00:00:00.000Z",
        resolvedAt: "2026-07-16T00:01:00.000Z",
      })}\n`,
      "utf8",
    );
    const manifestStore = new DownloadManifestStore(manifestPath);
    const failureStore = new FailureStore(failurePath);
    const worker = new DownloadWorker({
      downloader: new PdfDownloader(new QueueClient([() => response(validPdf)]), {
        outputDir,
        maxPdfBytes: 1024,
      }),
      manifestStore,
      failureStore,
      createId: () => uuid(803),
    });

    await expect(worker.run([document(1)])).resolves.toMatchObject({ downloaded: 1, failed: 0 });
    expect((await failureStore.readAll()).records).toHaveLength(1);
    expect((await manifestStore.currentStates()).get(uuid(1))?.state).toBe("downloaded");
  });

  it("respeta una señal ya abortada antes de inicializar y limpiar temporales", async () => {
    const outputDir = await root();
    const pdfDir = path.join(outputDir, "pdf");
    await mkdir(pdfDir);
    const temporary = path.join(pdfDir, "conservar.pdf.part");
    await writeFile(temporary, "pendiente", "utf8");
    const worker = new DownloadWorker({
      downloader: new PdfDownloader(new QueueClient([]), { outputDir, maxPdfBytes: 1024 }),
      manifestStore: new DownloadManifestStore(path.join(outputDir, "manifest.jsonl")),
      failureStore: new FailureStore(path.join(outputDir, "failures.jsonl")),
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelado antes de iniciar"));

    await expect(worker.run([document(1)], { signal: controller.signal })).rejects.toThrow(
      "cancelado antes de iniciar",
    );
    await expect(readFile(temporary, "utf8")).resolves.toBe("pendiente");
  });

  it("detecta documentos omitidos y duplicados al reconciliar cobertura", () => {
    expect(() => reconcileDownloadCoverage([document(1)], new Map())).toThrow(/sin estado/u);
    expect(() => reconcileDownloadCoverage([document(1), document(1)], new Map())).toThrow(
      /duplicado/u,
    );
  });

  it("expone un error tipado al agotar reintentos de stream", async () => {
    const outputDir = await root();
    const broken = (): ControlledResponse<Readable> => ({
      ...response(validPdf),
      data: Readable.from(
        (function* () {
          yield Buffer.from("%PDF-");
          throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
        })(),
      ),
      headers: {},
    });
    const downloader = new PdfDownloader(new QueueClient([broken, broken]), {
      outputDir,
      maxPdfBytes: 1024,
      maxStreamRetries: 1,
      sleep: () => Promise.resolve(),
    });
    await expect(downloader.download(document(1))).rejects.toBeInstanceOf(PdfDownloadError);
  });
});
