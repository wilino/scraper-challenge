import { mkdir, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import type { ZodType } from "zod";

export interface JsonlReadResult<T> {
  records: T[];
  truncatedLastLine: boolean;
}

export interface JsonlScanResult {
  records: number;
  truncatedLastLine: boolean;
}

export type JsonlRecordVisitor<T> = (record: T, line: number) => void | Promise<void>;

export class JsonlCorruptionError extends Error {
  public constructor(filePath: string, line: number, cause: unknown) {
    super(`JSONL corrupto en ${filePath}, línea ${String(line)}`, { cause });
    this.name = "JsonlCorruptionError";
  }
}

export class JsonlStore<T> {
  readonly #filePath: string;
  readonly #schema: ZodType<T>;
  #writeQueue: Promise<void> = Promise.resolve();

  public constructor(filePath: string, schema: ZodType<T>) {
    this.#filePath = filePath;
    this.#schema = schema;
  }

  public append(value: T): Promise<void> {
    const validated = this.#schema.parse(value);
    const operation = this.#writeQueue.then(async () => {
      await mkdir(path.dirname(this.#filePath), { recursive: true });
      const handle = await open(this.#filePath, "a");
      try {
        await handle.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.#writeQueue = operation.catch(() => undefined);
    return operation;
  }

  public async readAll(signal?: AbortSignal): Promise<JsonlReadResult<T>> {
    const records: T[] = [];
    const result = await this.scan((record) => {
      records.push(record);
    }, signal);
    return { records, truncatedLastLine: result.truncatedLastLine };
  }

  /**
   * Valida y visita cada registro en orden, aplicando backpressure al visitor.
   * Solo conserva la línea pendiente necesaria para distinguir una última línea
   * truncada de corrupción en una línea confirmada.
   */
  public async scan(visit: JsonlRecordVisitor<T>, signal?: AbortSignal): Promise<JsonlScanResult> {
    signal?.throwIfAborted();
    let handle: FileHandle;
    try {
      handle = await open(this.#filePath, "r");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT")
        return { records: 0, truncatedLastLine: false };
      throw error;
    }

    try {
      const { size } = await handle.stat();
      if (size === 0) return { records: 0, truncatedLastLine: false };
      const finalByte = Buffer.alloc(1);
      await handle.read(finalByte, 0, 1, size - 1);
      const endsWithNewline = finalByte[0] === 10;
      const reader = createInterface({
        input: handle.createReadStream({ encoding: "utf8", autoClose: false, start: 0 }),
        crlfDelay: Infinity,
      });
      let records = 0;
      let pendingLine: string | undefined;
      let pendingNumber = 0;
      for await (const line of reader) {
        signal?.throwIfAborted();
        if (pendingLine !== undefined) {
          const record = this.#parseLine(pendingLine, pendingNumber, false);
          if (record !== undefined) {
            await visit(record, pendingNumber);
            records += 1;
          }
        }
        pendingLine = line;
        pendingNumber += 1;
      }
      if (pendingLine === undefined || pendingLine.trim() === "") {
        return { records, truncatedLastLine: false };
      }
      signal?.throwIfAborted();
      let finalRecord: T | undefined;
      try {
        finalRecord = this.#parseLine(pendingLine, pendingNumber, true);
      } catch (error: unknown) {
        if (!endsWithNewline) return { records, truncatedLastLine: true };
        throw error;
      }
      if (finalRecord !== undefined) {
        await visit(finalRecord, pendingNumber);
        records += 1;
      }
      return { records, truncatedLastLine: false };
    } finally {
      await handle.close();
    }
  }

  #parseLine(line: string, lineNumber: number, isLast: boolean): T | undefined {
    if (line.trim() === "") return undefined;
    try {
      return this.#schema.parse(JSON.parse(line));
    } catch (error: unknown) {
      throw new JsonlCorruptionError(
        this.#filePath,
        lineNumber,
        isLast ? new Error("última línea inválida", { cause: error }) : error,
      );
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
