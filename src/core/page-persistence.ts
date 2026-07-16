import type { Checkpoint } from "../models/checkpoint.js";
import { scrapedDocumentSchema, type ScrapedDocument } from "../models/document.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { CompletedIdStore } from "./completed-id-store.js";
import { JsonlStore } from "./jsonl-store.js";

export class PagePersistence {
  readonly #documents: JsonlStore<ScrapedDocument>;
  readonly #completedIds: CompletedIdStore;
  readonly #checkpoint: CheckpointStore;

  public constructor(outputDirectory: string) {
    this.#documents = new JsonlStore(
      `${outputDirectory}/data/documents.jsonl`,
      scrapedDocumentSchema,
    );
    this.#completedIds = new CompletedIdStore(`${outputDirectory}/state/completed-ids.txt`);
    this.#checkpoint = new CheckpointStore(`${outputDirectory}/state/checkpoint.json`);
  }

  public async initialize(): Promise<readonly ScrapedDocument[]> {
    const records: ScrapedDocument[] = [];
    await this.scanDocuments((document) => {
      records.push(document);
    });
    return records;
  }

  public async scanDocuments(
    visit: (document: ScrapedDocument) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<{ records: number; truncatedLastLine: boolean }> {
    await this.#completedIds.load();
    return await this.#documents.scan(async (document) => {
      await this.#completedIds.add(document.documentId);
      await visit(document);
    }, signal);
  }

  public hasDocument(documentId: string): boolean {
    return this.#completedIds.has(documentId);
  }

  public confirmCheckpoint(checkpoint: Checkpoint): Promise<void> {
    return this.#checkpoint.save(checkpoint);
  }

  public async confirmDocuments(
    documents: readonly ScrapedDocument[],
    checkpoint: Checkpoint,
  ): Promise<number> {
    const inserted = await this.persistDocuments(documents);
    await this.#checkpoint.save(checkpoint);
    return inserted;
  }

  public async persistDocuments(documents: readonly ScrapedDocument[]): Promise<number> {
    let inserted = 0;
    for (const document of documents) {
      if (this.#completedIds.has(document.documentId)) continue;
      await this.#documents.append(document);
      await this.#completedIds.add(document.documentId);
      inserted += 1;
    }
    return inserted;
  }

  public loadCheckpoint(): Promise<Checkpoint | null> {
    return this.#checkpoint.load();
  }
}
