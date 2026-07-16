import { scrapeFailureSchema, type ScrapeFailure } from "../models/failure.js";
import { JsonlStore } from "./jsonl-store.js";

export class FailureStore extends JsonlStore<ScrapeFailure> {
  public constructor(filePath: string) {
    super(filePath, scrapeFailureSchema);
  }

  public async resolve(failureId: string, resolvedAt: string): Promise<ScrapeFailure> {
    const { records } = await this.readAll();
    let current: ScrapeFailure | undefined;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const candidate = records[index];
      if (candidate?.failureId === failureId) {
        current = candidate;
        break;
      }
    }
    if (current === undefined) throw new Error(`Fallo no encontrado: ${failureId}`);
    const resolved: ScrapeFailure = {
      ...current,
      resolution: "resolved",
      resolvedAt,
    };
    await this.append(resolved);
    return resolved;
  }

  public async resolveOpenForDocument(
    phase: ScrapeFailure["phase"],
    documentId: string,
    resolvedAt: string,
  ): Promise<number> {
    const { records } = await this.readAll();
    const currentById = new Map<string, ScrapeFailure>();
    for (const failure of records) currentById.set(failure.failureId, failure);
    const open = [...currentById.values()].filter(
      (failure) =>
        failure.phase === phase &&
        failure.documentId === documentId &&
        failure.resolution === "open",
    );
    for (const failure of open) {
      await this.append({ ...failure, resolution: "resolved", resolvedAt });
    }
    return open.length;
  }
}
