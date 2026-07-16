import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

import type { ControlledResponse, PjHttpClient } from "./http-client.js";
import { HttpRequestError } from "./http-errors.js";
import type { DownloadResumeState } from "./download-manifest-store.js";
import type { ScrapedDocument } from "../models/document.js";
import { httpRequestSpecSchema } from "../models/http-request.js";
import { pdfFileName, relativeOutputPath, resolvePdfPath } from "../utils/file-names.js";
import { sha256File } from "../utils/hash.js";
import { PdfValidationError, PdfValidationStream } from "./pdf-validator.js";

export interface PdfStreamClient {
  requestPdfStream(
    url: string | URL,
    documentId: string,
    signal?: AbortSignal,
  ): Promise<ControlledResponse<Readable>>;
}

export interface PdfDownloaderOptions {
  outputDir: string;
  minPdfBytes?: number;
  maxPdfBytes: number;
  maxStreamRetries?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface PdfDownloadResult {
  state: "downloaded" | "skipped";
  relativePath: string;
  sha256: string;
  bytes: number;
  effectiveUrl: string;
  attempts: number;
}

export class PdfDownloadError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly attempts: number,
    public readonly diagnosticSample?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PdfDownloadError";
  }
}

function parseContentLength(headers: Readonly<Record<string, string>>): number | undefined {
  const raw = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "content-length",
  )?.[1];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Descarga interrumpida"));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Descarga interrumpida"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class PdfDownloader {
  readonly #pdfDir: string;
  readonly #sleep: NonNullable<PdfDownloaderOptions["sleep"]>;

  public constructor(
    private readonly client: PdfStreamClient | PjHttpClient,
    private readonly options: PdfDownloaderOptions,
  ) {
    this.#pdfDir = path.resolve(options.outputDir, "pdf");
    this.#sleep = options.sleep ?? defaultSleep;
  }

  public async initialize(): Promise<void> {
    await mkdir(this.#pdfDir, { recursive: true });
    const directory = await lstat(this.#pdfDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error("OUTPUT_DIR/pdf debe ser un directorio real, no un enlace simbólico");
    }
    for (const entry of await readdir(this.#pdfDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".pdf.part")) {
        await unlink(path.join(this.#pdfDir, entry.name));
      }
    }
  }

  public async download(
    document: ScrapedDocument,
    current?: DownloadResumeState,
    signal?: AbortSignal,
  ): Promise<PdfDownloadResult> {
    if (document.pdf.state !== "pending") {
      throw new PdfDownloadError("El documento no anuncia PDF", "PDF_NOT_ADVERTISED", false, 1);
    }
    const parsedRequest = httpRequestSpecSchema.safeParse(document.pdf.request);
    if (!parsedRequest.success) {
      throw new HttpRequestError("Descriptor PDF PJ no permitido", {
        classification: "security",
        retryable: false,
        safePath: "/jurisprudenciaweb/ServletDescarga",
        attempt: 1,
        code: "ERR_UNSAFE_PDF_DESCRIPTOR",
        cause: parsedRequest.error,
      });
    }
    const request = parsedRequest.data;
    const finalPath = resolvePdfPath(this.options.outputDir, pdfFileName(document));
    const relativePath = relativeOutputPath(this.options.outputDir, finalPath);
    if (current?.state === "downloaded") {
      const existing = await this.validateExisting(current, finalPath);
      if (existing !== undefined) return { state: "skipped", attempts: 0, ...existing };
    }

    await unlinkIfExists(finalPath);
    const partPath = `${finalPath}.part`;
    const maxAttempts = (this.options.maxStreamRetries ?? 2) + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await this.client.requestPdfStream(
          request.url,
          document.documentId,
          signal,
        );
        if (response.status < 200 || response.status >= 300) {
          response.data.destroy();
          throw new PdfDownloadError(
            `Estado HTTP PDF inesperado: ${String(response.status)}`,
            "PDF_HTTP_STATUS",
            response.status >= 500 || response.status === 429,
            attempt,
          );
        }
        const effectiveRequest = httpRequestSpecSchema.safeParse({
          method: "GET",
          url: response.url,
        });
        if (!effectiveRequest.success) {
          response.data.destroy();
          throw new HttpRequestError("URL efectiva PDF PJ no permitida", {
            classification: "security",
            retryable: false,
            safePath: new URL(response.url).pathname,
            attempt,
            code: "ERR_UNSAFE_PDF_REDIRECT",
            cause: effectiveRequest.error,
          });
        }
        const expectedBytes = parseContentLength(response.headers);
        if (expectedBytes !== undefined && expectedBytes > this.options.maxPdfBytes) {
          response.data.destroy();
          throw new PdfDownloadError(
            "Content-Length excede MAX_PDF_BYTES",
            "PDF_TOO_LARGE",
            false,
            attempt,
          );
        }
        const validator = new PdfValidationStream({
          minBytes: this.options.minPdfBytes ?? 5,
          maxBytes: this.options.maxPdfBytes,
          ...(expectedBytes === undefined ? {} : { expectedBytes }),
        });
        const timer = setTimeout(() => {
          response.data.destroy(
            new PdfDownloadError("El stream PDF agotó el timeout", "PDF_TIMEOUT", true, attempt),
          );
        }, this.options.timeoutMs ?? 120_000);
        try {
          await pipeline(response.data, validator, createWriteStream(partPath, { flags: "wx" }));
        } finally {
          clearTimeout(timer);
        }
        const result = validator.result();
        await rename(partPath, finalPath);
        return {
          state: "downloaded",
          relativePath,
          sha256: result.sha256,
          bytes: result.bytes,
          effectiveUrl: response.url,
          attempts: response.attempts + attempt - 1,
        };
      } catch (error: unknown) {
        try {
          await unlinkIfExists(partPath);
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            `No se pudo limpiar el temporal PDF ${path.basename(partPath)}`,
            { cause: cleanupError },
          );
        }
        if (error instanceof HttpRequestError) throw error;
        const normalized = this.normalizeError(error, attempt);
        if (!normalized.retryable || attempt === maxAttempts) throw normalized;
        await this.#sleep((this.options.retryBaseMs ?? 250) * 2 ** (attempt - 1), signal);
      }
    }
    throw new PdfDownloadError(
      "Descarga PDF agotada",
      "PDF_DOWNLOAD_EXHAUSTED",
      false,
      maxAttempts,
    );
  }

  private async validateExisting(
    event: Extract<DownloadResumeState, { state: "downloaded" }>,
    expectedPath: string,
  ): Promise<Omit<PdfDownloadResult, "state" | "attempts"> | undefined> {
    const registeredPath = path.resolve(this.options.outputDir, event.relativePath);
    if (registeredPath !== expectedPath) return undefined;
    try {
      const file = await lstat(registeredPath);
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        file.size !== event.bytes ||
        file.size < (this.options.minPdfBytes ?? 5)
      ) {
        return undefined;
      }
      const handle = createReadStream(registeredPath, { start: 0, end: 4 });
      const chunks: Buffer[] = [];
      for await (const chunk of handle) chunks.push(chunk as Buffer);
      if (!Buffer.concat(chunks).equals(Buffer.from("%PDF-"))) return undefined;
      if ((await sha256File(registeredPath)) !== event.sha256) return undefined;
      return {
        relativePath: event.relativePath,
        sha256: event.sha256,
        bytes: event.bytes,
        effectiveUrl: event.effectiveUrl,
      };
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private normalizeError(error: unknown, attempt: number): PdfDownloadError {
    if (error instanceof PdfDownloadError) return error;
    if (error instanceof PdfValidationError) {
      return new PdfDownloadError(
        error.message,
        error.code,
        error.retryable,
        attempt,
        error.diagnosticSample,
        { cause: error },
      );
    }
    const code =
      error instanceof Error && "code" in error ? String(error.code) : "PDF_STREAM_ERROR";
    const retryable = code === "ERR_STREAM_PREMATURE_CLOSE" || code === "ECONNRESET";
    return new PdfDownloadError(
      error instanceof Error ? error.message : "Error desconocido en el stream PDF",
      code,
      retryable,
      attempt,
      undefined,
      { cause: error },
    );
  }
}
