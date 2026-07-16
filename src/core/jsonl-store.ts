import { mkdir, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import type { ZodType } from "zod";

export interface JsonlReadResult<T> {
  records: T[];
  truncatedLastLine: boolean;
}

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

  public async readAll(): Promise<JsonlReadResult<T>> {
    let handle: FileHandle;
    try {
      handle = await open(this.#filePath, "r");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT")
        return { records: [], truncatedLastLine: false };
      throw error;
    }

    try {
      const { size } = await handle.stat();
      if (size === 0) return { records: [], truncatedLastLine: false };
      const finalByte = Buffer.alloc(1);
      await handle.read(finalByte, 0, 1, size - 1);
      const endsWithNewline = finalByte[0] === 10;
      const reader = createInterface({
        input: handle.createReadStream({ encoding: "utf8", autoClose: false, start: 0 }),
        crlfDelay: Infinity,
      });
      const records: T[] = [];
      let pendingLine: string | undefined;
      let pendingNumber = 0;
      for await (const line of reader) {
        if (pendingLine !== undefined) this.#parseLine(pendingLine, pendingNumber, records, false);
        pendingLine = line;
        pendingNumber += 1;
      }
      if (pendingLine === undefined || pendingLine.trim() === "") {
        return { records, truncatedLastLine: false };
      }
      try {
        this.#parseLine(pendingLine, pendingNumber, records, true);
      } catch (error: unknown) {
        if (!endsWithNewline) return { records, truncatedLastLine: true };
        throw error;
      }
      return { records, truncatedLastLine: false };
    } finally {
      await handle.close();
    }
  }

  #parseLine(line: string, lineNumber: number, records: T[], isLast: boolean): void {
    if (line.trim() === "") return;
    try {
      records.push(this.#schema.parse(JSON.parse(line)));
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
