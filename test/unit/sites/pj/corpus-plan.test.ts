import { readFile, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  corpusPlanArtifact,
  CorpusPlanArtifactError,
  ensureCorpusPlanArtifact,
} from "../../../../src/sites/pj/corpus-plan-artifact.js";
import {
  CORPUS_PLAN,
  hashCorpusPlan,
  selectCorpusPlan,
} from "../../../../src/sites/pj/corpus-plan.js";
import {
  PjDiscoverySource,
  type PjDiscoveryAdapter,
} from "../../../../src/sites/pj/discovery-source.js";
import { PjCorpusDiscoverySource } from "../../../../src/sites/pj/corpus-discovery-source.js";
import type { PjHistoricalDiscoverySource } from "../../../../src/sites/pj/historical-discovery-source.js";

const COMMIT = "a".repeat(40);

function temporaryDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), "pj-corpus-plan-"));
}

describe("CorpusPlan", () => {
  it("es la autoridad del orden y de las tres consultas aprobadas", () => {
    expect(CORPUS_PLAN.partitionIds).toEqual([
      "supreme",
      "superior",
      "historical-arbitration-lima",
    ]);
    expect(CORPUS_PLAN.partitions).toMatchObject([
      {
        id: "supreme",
        kind: "main",
        search: {
          court: "supreme",
          query: "",
          mode: "specialized",
          includeAutoQualifiers: true,
        },
      },
      {
        id: "superior",
        kind: "main",
        search: { court: "superior", query: "", mode: "general" },
      },
      {
        id: "historical-arbitration-lima",
        kind: "historical",
        search: { court: 2, instance: 2, specialty: 2, year: "" },
      },
    ]);
  });

  it("cambia queryHash cuando cambia o se reordena una partición", () => {
    const changed = CORPUS_PLAN.partitions.map((partition) =>
      partition.id === "supreme"
        ? { ...partition, search: { ...partition.search, query: "cambio" } }
        : partition,
    );
    expect(hashCorpusPlan(CORPUS_PLAN.version, changed)).not.toBe(CORPUS_PLAN.queryHash);
    expect(hashCorpusPlan(CORPUS_PLAN.version, [...CORPUS_PLAN.partitions].reverse())).not.toBe(
      CORPUS_PLAN.queryHash,
    );
  });

  it("deriva un plan parcial con hash propio sin duplicar la definición", () => {
    const partial = selectCorpusPlan("superior");
    expect(partial.partitionIds).toEqual(["superior"]);
    expect(partial.partitions[0]).toBe(CORPUS_PLAN.partitions[1]);
    expect(partial.queryHash).not.toBe(CORPUS_PLAN.queryHash);
  });

  it("alimenta a PjDiscoverySource sin redefinir el payload", async () => {
    const observed = vi.fn();
    const sentinel = new Error("search reached");
    const adapter = {
      preflight: vi.fn(),
      bootstrap: vi.fn(),
      search: vi.fn((options: unknown) => {
        observed(options);
        return Promise.reject(sentinel);
      }),
    } as unknown as PjDiscoveryAdapter;

    await expect(new PjDiscoverySource(adapter).openPartition("supreme", 1)).rejects.toBe(sentinel);
    expect(observed).toHaveBeenCalledWith(CORPUS_PLAN.partitions[0]?.search);
  });

  it.each([
    ["superior", 1, 0],
    ["historical-arbitration-lima", 0, 1],
  ] as const)(
    "limita el preflight de una canary %s a su adaptador",
    async (partitionId, mainCalls, historicalCalls) => {
      const mainPreflight = vi.fn(() => Promise.resolve());
      const historicalPreflight = vi.fn(() => Promise.resolve());
      const source = new PjCorpusDiscoverySource(
        { preflight: mainPreflight } as unknown as PjDiscoverySource,
        { preflight: historicalPreflight } as unknown as PjHistoricalDiscoverySource,
        [partitionId],
      );

      await source.preflight();

      expect(mainPreflight).toHaveBeenCalledTimes(mainCalls);
      expect(historicalPreflight).toHaveBeenCalledTimes(historicalCalls);
    },
  );
});

describe("corpus-plan.json", () => {
  it("se crea machine-readable al inicializar un OUTPUT_DIR vacío", async () => {
    const output = temporaryDirectory();
    await ensureCorpusPlanArtifact(output, COMMIT);
    const stored = JSON.parse(
      await readFile(path.join(output, "corpus-plan.json"), "utf8"),
    ) as unknown;
    expect(stored).toEqual(corpusPlanArtifact(COMMIT));
  });

  it("considera vacío el OUTPUT_DIR predeterminado que solo contiene .gitkeep", async () => {
    const output = temporaryDirectory();
    await writeFile(path.join(output, ".gitkeep"), "");

    await ensureCorpusPlanArtifact(output, COMMIT);

    await expect(readFile(path.join(output, "corpus-plan.json"), "utf8")).resolves.toContain(
      CORPUS_PLAN.queryHash,
    );
  });

  it.each([
    [
      "hash alterado",
      (artifact: ReturnType<typeof corpusPlanArtifact>) => ({
        ...artifact,
        queryHash: "b".repeat(64),
      }),
    ],
    [
      "commit incorrecto",
      (artifact: ReturnType<typeof corpusPlanArtifact>) => ({
        ...artifact,
        commit: "b".repeat(40),
      }),
    ],
    [
      "particiones reordenadas",
      (artifact: ReturnType<typeof corpusPlanArtifact>) => ({
        ...artifact,
        partitions: [...artifact.partitions].reverse(),
      }),
    ],
    [
      "partición cambiada",
      (artifact: ReturnType<typeof corpusPlanArtifact>) => ({
        ...artifact,
        partitions: artifact.partitions.map((partition) =>
          partition.id === "supreme"
            ? { ...partition, search: { ...partition.search, query: "otra" } }
            : partition,
        ),
      }),
    ],
  ])("rechaza %s", async (_label, mutate) => {
    const output = temporaryDirectory();
    await writeFile(
      path.join(output, "corpus-plan.json"),
      JSON.stringify(mutate(corpusPlanArtifact(COMMIT))),
    );
    await expect(ensureCorpusPlanArtifact(output, COMMIT)).rejects.toBeInstanceOf(
      CorpusPlanArtifactError,
    );
  });

  it("no adopta silenciosamente un dataset previo sin artefacto", async () => {
    const output = temporaryDirectory();
    await writeFile(path.join(output, "documents.jsonl"), "{}\n");
    await expect(ensureCorpusPlanArtifact(output, COMMIT)).rejects.toThrow(/OUTPUT_DIR nuevo/);
  });

  it("impide mezclar una canary parcial con el plan global", async () => {
    const output = temporaryDirectory();
    await ensureCorpusPlanArtifact(output, COMMIT, selectCorpusPlan("supreme"));
    await expect(ensureCorpusPlanArtifact(output, COMMIT)).rejects.toBeInstanceOf(
      CorpusPlanArtifactError,
    );
  });
});
