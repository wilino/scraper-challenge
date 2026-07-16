import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { CORPUS_PLAN, selectCorpusPlan, type SelectedCorpusPlan } from "./corpus-plan.js";

const execFileAsync = promisify(execFile);
const COMMIT = /^[0-9a-f]{40}$/u;

export class CorpusPlanArtifactError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CorpusPlanArtifactError";
  }
}

export function corpusPlanArtifact(commit: string, plan: SelectedCorpusPlan = CORPUS_PLAN) {
  if (!COMMIT.test(commit)) throw new CorpusPlanArtifactError("El commit debe ser un SHA completo");
  return {
    schemaVersion: 1 as const,
    corpusPlanVersion: plan.version,
    queryHash: plan.queryHash,
    commit,
    fingerprint: plan.fingerprint,
    partitions: plan.partitions.map((partition) => ({
      ...partition,
      search: { ...partition.search },
      fingerprint: createPartitionFingerprint(partition),
    })),
  };
}

function createPartitionFingerprint(partition: (typeof CORPUS_PLAN.partitions)[number]): string {
  return createHash("sha256").update(JSON.stringify(partition)).digest("hex");
}

export async function resolveCurrentCommit(cwd: string = process.cwd()): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
    });
    const commit = stdout.trim();
    if (!COMMIT.test(commit)) throw new Error("salida inesperada de git rev-parse");
    return commit;
  } catch (error: unknown) {
    throw new CorpusPlanArtifactError("No se pudo ligar el dataset al commit actual", {
      cause: error,
    });
  }
}

export async function ensureCorpusPlanArtifact(
  outputDirectory: string,
  commit: string,
  plan: SelectedCorpusPlan = CORPUS_PLAN,
): Promise<void> {
  const expected = corpusPlanArtifact(commit, plan);
  const artifactPath = path.join(outputDirectory, "corpus-plan.json");
  await mkdir(outputDirectory, { recursive: true });
  try {
    const current = JSON.parse(await readFile(artifactPath, "utf8")) as unknown;
    assertExactArtifact(current, expected);
    return;
  } catch (error: unknown) {
    if (!isMissing(error)) {
      if (error instanceof CorpusPlanArtifactError) throw error;
      throw new CorpusPlanArtifactError("corpus-plan.json es inválido", { cause: error });
    }
  }

  const datasetEntries = (await readdir(outputDirectory)).filter((entry) => entry !== ".gitkeep");
  if (datasetEntries.length > 0) {
    throw new CorpusPlanArtifactError(
      "El dataset existente no tiene corpus-plan.json; use un OUTPUT_DIR nuevo",
    );
  }
  const handle = await open(
    artifactPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(expected, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function ensureExistingCorpusPlanArtifact(
  outputDirectory: string,
  commit: string,
): Promise<SelectedCorpusPlan> {
  const artifactPath = path.join(outputDirectory, "corpus-plan.json");
  let current: unknown;
  try {
    current = JSON.parse(await readFile(artifactPath, "utf8")) as unknown;
  } catch (error: unknown) {
    if (isMissing(error)) {
      await ensureCorpusPlanArtifact(outputDirectory, commit);
      return CORPUS_PLAN;
    }
    throw new CorpusPlanArtifactError("corpus-plan.json es inválido", { cause: error });
  }
  const candidates = [
    CORPUS_PLAN,
    ...CORPUS_PLAN.partitionIds.map((partitionId) => selectCorpusPlan(partitionId)),
  ];
  const matching = candidates.find(
    (candidate) =>
      JSON.stringify(current) === JSON.stringify(corpusPlanArtifact(commit, candidate)),
  );
  if (matching === undefined) {
    throw new CorpusPlanArtifactError(
      "corpus-plan.json no coincide con un plan global o parcial vigente para este commit",
    );
  }
  return matching;
}

function assertExactArtifact(
  current: unknown,
  expected: ReturnType<typeof corpusPlanArtifact>,
): void {
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new CorpusPlanArtifactError(
      "corpus-plan.json no coincide exactamente con plan, hash, commit o particiones actuales",
    );
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
