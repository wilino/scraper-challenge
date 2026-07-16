import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const documentIdSchema = z.uuid();

export class CompletedIdStore {
  readonly #filePath: string;
  readonly #ids = new Set<string>();
  #loaded = false;
  #writeQueue: Promise<void> = Promise.resolve();

  public constructor(filePath: string) {
    this.#filePath = filePath;
  }

  public async load(): Promise<void> {
    if (this.#loaded) return;
    try {
      const content = await readFile(this.#filePath, "utf8");
      for (const line of content.split("\n")) {
        if (line.trim() !== "") this.#ids.add(documentIdSchema.parse(line.trim()));
      }
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    this.#loaded = true;
  }

  public has(documentId: string): boolean {
    return this.#ids.has(documentIdSchema.parse(documentId));
  }

  public add(documentId: string): Promise<boolean> {
    const validated = documentIdSchema.parse(documentId);
    if (this.#ids.has(validated)) return Promise.resolve(false);
    this.#ids.add(validated);
    const operation = this.#writeQueue.then(async () => {
      await mkdir(path.dirname(this.#filePath), { recursive: true });
      await writeFile(this.#filePath, `${validated}\n`, { encoding: "utf8", flag: "a" });
    });
    this.#writeQueue = operation.catch(() => undefined);
    return operation.then(() => true);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
