import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { checkpointSchema, type Checkpoint } from "../models/checkpoint.js";

export class CheckpointStore {
  readonly #filePath: string;

  public constructor(filePath: string) {
    this.#filePath = filePath;
  }

  public async load(): Promise<Checkpoint | null> {
    try {
      return checkpointSchema.parse(JSON.parse(await readFile(this.#filePath, "utf8")));
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw new Error("Checkpoint inválido; reinicie explícitamente o migre el estado", {
        cause: error,
      });
    }
  }

  public async save(checkpoint: Checkpoint): Promise<void> {
    const validated = checkpointSchema.parse(checkpoint);
    const temporaryPath = `${this.#filePath}.tmp`;
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryPath, this.#filePath);
    } catch (error: unknown) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
