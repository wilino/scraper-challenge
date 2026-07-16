import type {
  DiscoveryPage,
  DiscoverySource,
  EnrichRecordContext,
} from "../../core/discovery-types.js";
import { scrapedDocumentSchema, type ScrapedDocument } from "../../models/document.js";
import type { CompletePjRecord } from "./adapter.js";
import type { PjListRecord, PjParsedResults } from "./parser.js";
import { corpusPartition } from "./corpus-plan.js";
import type { PjCourt } from "./selectors.js";

export interface PjDiscoveryAdapter {
  preflight(signal?: AbortSignal): Promise<void>;
  bootstrap(signal?: AbortSignal): Promise<void>;
  search(
    options: {
      court: PjCourt;
      query?: string;
      mode?: "general" | "specialized";
      includeAutoQualifiers?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<PjParsedResults>;
  goToPage(page: number, signal?: AbortSignal): Promise<PjParsedResults>;
  nextPage(signal?: AbortSignal): Promise<PjParsedResults>;
  fetchDetail(
    record: PjListRecord,
    signal?: AbortSignal,
  ): Promise<Pick<CompletePjRecord, "merged">>;
}

export class PjDiscoverySource implements DiscoverySource<PjListRecord> {
  readonly #now: () => Date;

  public constructor(
    private readonly adapter: PjDiscoveryAdapter,
    now: () => Date = () => new Date(),
  ) {
    this.#now = now;
  }

  public async preflight(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.adapter.preflight(signal);
  }

  public async openPartition(
    partitionId: string,
    resumePage: number,
    signal?: AbortSignal,
  ): Promise<DiscoveryPage<PjListRecord>> {
    const partition = corpusPartition(partitionId);
    if (partition?.kind !== "main") throw new Error(`Partición PJ no soportada: ${partitionId}`);
    await this.adapter.bootstrap(signal);
    let parsed = await this.adapter.search({ ...partition.search }, signal);
    if (resumePage > 1) {
      signal?.throwIfAborted();
      parsed = await this.adapter.goToPage(resumePage, signal);
    }
    return { partitionId, parsed };
  }

  public async enrichRecord(
    record: PjListRecord,
    context: EnrichRecordContext,
  ): Promise<ScrapedDocument> {
    const { merged } = await this.adapter.fetchDetail(record, context.signal);
    const normalizedValue = (name: string): string | undefined => {
      const value = merged.normalized[name];
      if (Array.isArray(value)) return value.find((item) => item !== "");
      return value === "" ? undefined : value;
    };
    const input = {
      schemaVersion: 1 as const,
      documentId: record.nativeId,
      partitionId: context.partitionId,
      sourcePage: context.page,
      sourceRow: context.row,
      discoveredAt: this.#now().toISOString(),
      ...(normalizedValue("title") === undefined ? {} : { title: normalizedValue("title") }),
      ...(normalizedValue("caseNumber") === undefined
        ? {}
        : { caseNumber: normalizedValue("caseNumber") }),
      ...(normalizedValue("resolutionDate") === undefined
        ? {}
        : { resolutionDate: normalizedValue("resolutionDate") }),
      metadata: merged.metadata,
      ...(merged.wordUrl === undefined ? {} : { wordUrl: merged.wordUrl }),
      pdf:
        merged.pdf === undefined
          ? {
              state: "no_pdf" as const,
              reason:
                merged.wordUrl === undefined ? ("not_advertised" as const) : ("word_only" as const),
            }
          : { state: "pending" as const, request: merged.pdf },
    };
    return scrapedDocumentSchema.parse(input);
  }

  public membershipIdentity(record: PjListRecord): { documentUuid: string } {
    return { documentUuid: record.nativeId };
  }

  public async nextPage(
    current: DiscoveryPage<PjListRecord>,
    signal?: AbortSignal,
  ): Promise<DiscoveryPage<PjListRecord> | null> {
    if (current.parsed.pagination.endSignal === "natural_end") return null;
    const parsed: PjParsedResults = await this.adapter.nextPage(signal);
    return { partitionId: current.partitionId, parsed };
  }
}
