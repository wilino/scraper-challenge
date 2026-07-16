import type {
  DiscoveryPage,
  DiscoverySource,
  EnrichRecordContext,
} from "../../core/discovery-types.js";
import { scrapedDocumentSchema, type ScrapedDocument } from "../../models/document.js";
import type { PjHistoricalAdapter } from "./historical-adapter.js";
import type { PjHistoricalParsedResults, PjHistoricalRecord } from "./historical-parser.js";

export const HISTORICAL_PARTITION = "historical-arbitration-lima";

export class PjHistoricalDiscoverySource implements DiscoverySource<PjHistoricalRecord> {
  constructor(
    private readonly adapter: Pick<
      PjHistoricalAdapter,
      "preflight" | "bootstrap" | "search" | "nextPage"
    >,
    private readonly now: () => Date = () => new Date(),
  ) {}

  preflight(signal?: AbortSignal): Promise<void> {
    return this.adapter.preflight(signal);
  }

  async openPartition(
    partitionId: string,
    resumePage: number,
    signal?: AbortSignal,
  ): Promise<DiscoveryPage<PjHistoricalRecord>> {
    if (partitionId !== HISTORICAL_PARTITION) {
      throw new Error(`Partición histórica no soportada: ${partitionId}`);
    }
    await this.adapter.bootstrap(signal);
    let parsed = await this.adapter.search(signal);
    for (let page = 2; page <= resumePage; page += 1) parsed = await this.adapter.nextPage(signal);
    return { partitionId, parsed };
  }

  enrichRecord(record: PjHistoricalRecord, context: EnrichRecordContext): Promise<ScrapedDocument> {
    const document = scrapedDocumentSchema.parse({
      schemaVersion: 1,
      documentId: record.nativeId,
      partitionId: context.partitionId,
      sourcePage: context.page,
      sourceRow: context.row,
      discoveredAt: this.now().toISOString(),
      title: "Anulación y ejecución de laudo arbitral",
      metadata: { list: record.metadata, detail: {}, unknownFields: {} },
      pdf: { state: "pending", request: record.pdf },
    });
    return Promise.resolve(document);
  }

  membershipIdentity(record: PjHistoricalRecord): { pdfUuid: string } {
    return { pdfUuid: record.nativeId };
  }

  async nextPage(
    current: DiscoveryPage<PjHistoricalRecord>,
    signal?: AbortSignal,
  ): Promise<DiscoveryPage<PjHistoricalRecord> | null> {
    if (current.parsed.pagination.endSignal === "natural_end") return null;
    const parsed: PjHistoricalParsedResults = await this.adapter.nextPage(signal);
    return { partitionId: current.partitionId, parsed };
  }
}
