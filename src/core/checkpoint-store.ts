import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { checkpointSchema, type Checkpoint } from "../models/checkpoint.js";

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(["EBADF", "EINVAL", "EISDIR", "ENOTSUP"]);

export class CheckpointStore {
  readonly #filePath: string;

  public constructor(filePath: string) {
    this.#filePath = filePath;
  }

  public async load(): Promise<Checkpoint | null> {
    try {
      const checkpoint = await this.#readCheckpoint(this.#filePath);
      await this.#removeAbandonedTemporaries();
      return checkpoint;
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw invalidCheckpoint(error);
      }
    }

    const temporaries = await this.#temporaryPaths();
    if (temporaries.length === 0) return null;

    const validity = await Promise.all(
      temporaries.map(async (temporaryPath) => {
        try {
          await this.#readCheckpoint(temporaryPath);
          return true;
        } catch {
          return false;
        }
      }),
    );
    const names = temporaries.map((temporaryPath) => path.basename(temporaryPath)).join(", ");
    if (temporaries.length === 1 && validity[0] === true) {
      throw new Error(
        `Checkpoint final ausente; existe un temporal válido (${names}). ` +
          "Revíselo y recupérelo explícitamente antes de reanudar.",
      );
    }
    throw new Error(
      `Checkpoint final ausente y temporales ambiguos o inválidos (${names}). ` +
        "Revise o elimine esos archivos explícitamente antes de reanudar.",
    );
  }

  public async save(checkpoint: Checkpoint): Promise<void> {
    const validated = checkpointSchema.parse(checkpoint);
    const directoryPath = path.dirname(this.#filePath);
    const temporaryPath = `${this.#filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
    await mkdir(directoryPath, { recursive: true });

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#filePath);
      await syncDirectory(directoryPath);
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async #readCheckpoint(filePath: string): Promise<Checkpoint> {
    return checkpointSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
  }

  async #temporaryPaths(): Promise<string[]> {
    const directoryPath = path.dirname(this.#filePath);
    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    const escapedName = escapeRegExp(path.basename(this.#filePath));
    const pattern = new RegExp(`^${escapedName}\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`, "i");
    return entries
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => path.join(directoryPath, entry.name))
      .sort();
  }

  async #removeAbandonedTemporaries(): Promise<void> {
    await Promise.all((await this.#temporaryPaths()).map((temporaryPath) => rm(temporaryPath)));
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directoryPath, "r");
    await handle.sync();
  } catch (error: unknown) {
    if (!isNodeError(error) || !UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error.code ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}

function invalidCheckpoint(cause: unknown): Error {
  return new Error("Checkpoint inválido; reinicie explícitamente o migre el estado", { cause });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
