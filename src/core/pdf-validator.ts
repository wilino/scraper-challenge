import { createHash, type Hash } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

export type PdfValidationCode =
  "PDF_EMPTY" | "PDF_TOO_SMALL" | "PDF_TOO_LARGE" | "PDF_INVALID_SIGNATURE" | "PDF_INCOMPLETE";

export class PdfValidationError extends Error {
  public constructor(
    message: string,
    public readonly code: PdfValidationCode,
    public readonly retryable: boolean,
    public readonly diagnosticSample?: string,
  ) {
    super(message);
    this.name = "PdfValidationError";
  }
}

export interface PdfValidationOptions {
  minBytes: number;
  maxBytes: number;
  expectedBytes?: number;
}

export interface PdfValidationResult {
  bytes: number;
  sha256: string;
}

export class PdfValidationStream extends Transform {
  readonly #hash: Hash = createHash("sha256");
  readonly #prefixChunks: Buffer[] = [];
  #prefixBytes = 0;
  #bytes = 0;
  #result?: PdfValidationResult;

  public constructor(private readonly options: PdfValidationOptions) {
    super();
  }

  public result(): PdfValidationResult {
    if (this.#result === undefined) throw new Error("La validación PDF todavía no terminó");
    return this.#result;
  }

  public override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.#bytes += buffer.length;
    if (this.#bytes > this.options.maxBytes) {
      callback(
        new PdfValidationError(
          `El PDF excede el máximo de ${String(this.options.maxBytes)} bytes`,
          "PDF_TOO_LARGE",
          false,
        ),
      );
      return;
    }
    this.#hash.update(buffer);
    if (this.#prefixBytes < 512) {
      const slice = buffer.subarray(0, 512 - this.#prefixBytes);
      this.#prefixChunks.push(slice);
      this.#prefixBytes += slice.length;
    }
    callback(undefined, buffer);
  }

  public override _flush(callback: TransformCallback): void {
    if (this.#bytes === 0) {
      callback(new PdfValidationError("El servidor devolvió un archivo vacío", "PDF_EMPTY", false));
      return;
    }
    if (this.#bytes < this.options.minBytes) {
      callback(
        new PdfValidationError(
          `El archivo tiene menos de ${String(this.options.minBytes)} bytes`,
          "PDF_TOO_SMALL",
          false,
          this.diagnosticSample(),
        ),
      );
      return;
    }
    const prefix = Buffer.concat(this.#prefixChunks);
    if (!prefix.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      callback(
        new PdfValidationError(
          "La respuesta no comienza con la firma %PDF-",
          "PDF_INVALID_SIGNATURE",
          false,
          this.diagnosticSample(),
        ),
      );
      return;
    }
    if (this.options.expectedBytes !== undefined && this.#bytes !== this.options.expectedBytes) {
      callback(
        new PdfValidationError(
          "El stream PDF terminó antes del Content-Length anunciado",
          "PDF_INCOMPLETE",
          true,
        ),
      );
      return;
    }
    this.#result = { bytes: this.#bytes, sha256: this.#hash.digest("hex") };
    callback();
  }

  private diagnosticSample(): string {
    return Buffer.concat(this.#prefixChunks)
      .toString("utf8")
      .replace(/\p{Cc}/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 200);
  }
}
