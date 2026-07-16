import type {
  DiscoveryPage,
  DiscoverySource,
  EnrichRecordContext,
} from "../../core/discovery-types.js";
import type { ScrapedDocument } from "../../models/document.js";
import type { CorpusIdentity } from "../../models/corpus-membership.js";
import { HISTORICAL_PARTITION } from "./historical-discovery-source.js";
import type { PjHistoricalDiscoverySource } from "./historical-discovery-source.js";
import type { PjHistoricalRecord } from "./historical-parser.js";
import type { PjDiscoverySource } from "./discovery-source.js";
import type { PjListRecord } from "./parser.js";

export type PjCorpusRecord = PjListRecord | PjHistoricalRecord;

export class PjCorpusDiscoverySource implements DiscoverySource<PjCorpusRecord> {
  constructor(
    private readonly main: PjDiscoverySource,
    private readonly historical: PjHistoricalDiscoverySource,
  ) {}

  async preflight(signal?: AbortSignal): Promise<void> {
    await this.main.preflight(signal);
    await this.historical.preflight(signal);
  }

  openPartition(
    partitionId: string,
    resumePage: number,
    signal?: AbortSignal,
  ): Promise<DiscoveryPage<PjCorpusRecord>> {
    return partitionId === HISTORICAL_PARTITION
      ? this.historical.openPartition(partitionId, resumePage, signal)
      : this.main.openPartition(partitionId, resumePage, signal);
  }

  enrichRecord(record: PjCorpusRecord, context: EnrichRecordContext): Promise<ScrapedDocument> {
    return context.partitionId === HISTORICAL_PARTITION
      ? this.historical.enrichRecord(record as PjHistoricalRecord, context)
      : this.main.enrichRecord(record as PjListRecord, context);
  }

  membershipIdentity(record: PjCorpusRecord): CorpusIdentity {
    return "detail" in record
      ? this.main.membershipIdentity(record)
      : this.historical.membershipIdentity(record);
  }

  nextPage(
    current: DiscoveryPage<PjCorpusRecord>,
    signal?: AbortSignal,
  ): Promise<DiscoveryPage<PjCorpusRecord> | null> {
    return current.partitionId === HISTORICAL_PARTITION
      ? this.historical.nextPage(current as DiscoveryPage<PjHistoricalRecord>, signal)
      : this.main.nextPage(current as DiscoveryPage<PjListRecord>, signal);
  }
}
