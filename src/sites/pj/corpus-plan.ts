import { createHash } from "node:crypto";

import type { SearchPayloadOptions } from "./request-builders.js";

export const CORPUS_PLAN_VERSION = "2026-07-16.r1";
export const HISTORICAL_PARTITION = "historical-arbitration-lima";

export interface MainCorpusPartition {
  readonly id: "supreme" | "superior";
  readonly kind: "main";
  readonly search: Readonly<Required<SearchPayloadOptions>>;
}

export interface HistoricalCorpusPartition {
  readonly id: "historical-arbitration-lima";
  readonly kind: "historical";
  readonly search: Readonly<{
    collection: "historical-arbitration-lima";
    court: 2;
    instance: 2;
    specialty: 2;
    year: "";
  }>;
}

export type CorpusPartition = MainCorpusPartition | HistoricalCorpusPartition;

export const HISTORICAL_CORPUS_SEARCH: HistoricalCorpusPartition["search"] = Object.freeze({
  collection: HISTORICAL_PARTITION,
  court: 2,
  instance: 2,
  specialty: 2,
  year: "",
});

const partitions: readonly CorpusPartition[] = Object.freeze([
  Object.freeze({
    id: "supreme",
    kind: "main",
    search: Object.freeze({
      court: "supreme",
      query: "",
      mode: "specialized",
      includeAutoQualifiers: true,
    }),
  }),
  Object.freeze({
    id: "superior",
    kind: "main",
    search: Object.freeze({
      court: "superior",
      query: "",
      mode: "general",
      includeAutoQualifiers: false,
    }),
  }),
  Object.freeze({
    id: "historical-arbitration-lima",
    kind: "historical",
    search: HISTORICAL_CORPUS_SEARCH,
  }),
]);

export function hashCorpusPlan(version: string, definitions: readonly CorpusPartition[]): string {
  return sha256({ version, partitions: definitions });
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export const CORPUS_PLAN = Object.freeze({
  version: CORPUS_PLAN_VERSION,
  partitions,
  partitionIds: Object.freeze(partitions.map(({ id }) => id)),
  queryHash: hashCorpusPlan(CORPUS_PLAN_VERSION, partitions),
  fingerprint: sha256({ schemaVersion: 1, version: CORPUS_PLAN_VERSION, partitions }),
});

export type CorpusPartitionId = CorpusPartition["id"];

export interface SelectedCorpusPlan {
  readonly version: string;
  readonly partitions: readonly CorpusPartition[];
  readonly partitionIds: readonly CorpusPartitionId[];
  readonly queryHash: string;
  readonly fingerprint: string;
}

export function selectCorpusPlan(partitionId?: CorpusPartitionId): SelectedCorpusPlan {
  const selected =
    partitionId === undefined
      ? CORPUS_PLAN.partitions
      : CORPUS_PLAN.partitions.filter(({ id }) => id === partitionId);
  return Object.freeze({
    version: CORPUS_PLAN.version,
    partitions: selected,
    partitionIds: Object.freeze(selected.map(({ id }) => id)),
    queryHash: hashCorpusPlan(CORPUS_PLAN.version, selected),
    fingerprint: sha256({
      schemaVersion: 1,
      version: CORPUS_PLAN.version,
      partitions: selected,
    }),
  });
}

export function corpusPartition(partitionId: string): CorpusPartition | undefined {
  return CORPUS_PLAN.partitions.find(({ id }) => id === partitionId);
}
