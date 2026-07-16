import type { ScrapedDocument } from "../models/document.js";
import type { CorpusIdentity } from "../models/corpus-membership.js";

export interface DiscoveryRecord {
  nativeId: string;
}

export interface DiscoveryParsedPage<TRecord extends DiscoveryRecord = DiscoveryRecord> {
  viewState: string;
  queryTotal: number;
  publishedGlobalTotal: number | null;
  records: TRecord[];
  pagination: {
    currentPage: number;
    maxPages: number;
    pageSize: number;
    hasNext: boolean;
    hasLast: boolean;
    endSignal: "more" | "natural_end";
  };
  fingerprint: string;
}

export interface DiscoveryPage<TRecord extends DiscoveryRecord = DiscoveryRecord> {
  partitionId: string;
  parsed: DiscoveryParsedPage<TRecord>;
}

export interface EnrichRecordContext {
  partitionId: string;
  page: number;
  row: number;
  signal?: AbortSignal;
}

/**
 * Puerto stateful implementado por el adaptador PJ. El orquestador nunca inicia
 * dos operaciones de este puerto simultáneamente.
 */
export interface DiscoverySource<TRecord extends DiscoveryRecord = DiscoveryRecord> {
  preflight(signal?: AbortSignal): Promise<void>;
  openPartition(
    partitionId: string,
    resumePage: number,
    signal?: AbortSignal,
  ): Promise<DiscoveryPage<TRecord>>;
  enrichRecord(record: TRecord, context: EnrichRecordContext): Promise<ScrapedDocument>;
  membershipIdentity?(record: TRecord): CorpusIdentity;
  nextPage(
    current: DiscoveryPage<TRecord>,
    signal?: AbortSignal,
  ): Promise<DiscoveryPage<TRecord> | null>;
}

export type SuccessfulTermination = "natural_end" | "limit" | "max_pages";

export type FailedTermination =
  | "interrupted"
  | "repeated_fingerprint"
  | "no_progress"
  | "partition_mismatch"
  | "reconciliation_mismatch";

export interface PartitionDiscoverySummary {
  partitionId: string;
  publishedGlobalTotal: number | null;
  queryTotal: number;
  maxPages: number;
  pagesVisited: number;
  rawMemberships: number;
  uniqueMemberships: number;
  duplicateMemberships: number;
  newDocuments: number;
  newCorpusMemberships: number;
  globalDuplicates: number;
  termination: SuccessfulTermination;
}

export interface DiscoverySummary {
  termination: SuccessfulTermination;
  datasetComplete: boolean;
  corpusGate: "pass" | "blocked";
  pagesVisited: number;
  rawMemberships: number;
  uniqueDocuments: number;
  duplicates: number;
  partitions: PartitionDiscoverySummary[];
  diagnostics: string[];
}

export interface DiscoveryRunOptions {
  limit?: number;
  maxPages?: number;
  resume?: boolean;
  signal?: AbortSignal;
}

export class DiscoveryConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DiscoveryConfigurationError";
  }
}

export class DiscoveryStopError extends Error {
  public constructor(
    public readonly reason: FailedTermination,
    message: string,
    public readonly diagnostics: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DiscoveryStopError";
  }
}
