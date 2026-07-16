import { scrapeFailureSchema, type ScrapeFailure } from "../models/failure.js";
import { JsonlStore } from "./jsonl-store.js";

export class FailureStore extends JsonlStore<ScrapeFailure> {
  readonly #currentById = new Map<string, ScrapeFailure>();
  readonly #openByDocument = new Map<string, Set<string>>();
  readonly #resolvedIds = new Set<string>();
  #initialization: Promise<void> | undefined;

  public constructor(filePath: string) {
    super(filePath, scrapeFailureSchema);
  }

  public override async append(value: ScrapeFailure, signal?: AbortSignal): Promise<void> {
    await this.initialize(signal);
    const failure = scrapeFailureSchema.parse(value);
    signal?.throwIfAborted();
    await super.append(failure);
    this.#remember(failure);
  }

  public async resolve(
    failureId: string,
    resolvedAt: string,
    signal?: AbortSignal,
  ): Promise<ScrapeFailure | undefined> {
    await this.initialize(signal);
    const current = this.#currentById.get(failureId);
    if (current === undefined) {
      if (this.#resolvedIds.has(failureId)) return undefined;
      throw new Error(`Fallo no encontrado: ${failureId}`);
    }
    const resolved: ScrapeFailure = {
      ...current,
      resolution: "resolved",
      resolvedAt,
    };
    signal?.throwIfAborted();
    await super.append(resolved);
    this.#remember(resolved);
    return resolved;
  }

  public async resolveOpenForDocument(
    phase: ScrapeFailure["phase"],
    documentId: string,
    resolvedAt: string,
    signal?: AbortSignal,
  ): Promise<number> {
    await this.initialize(signal);
    const key = documentKey(phase, documentId);
    const open = [...(this.#openByDocument.get(key) ?? [])].flatMap((failureId) => {
      const failure = this.#currentById.get(failureId);
      return failure?.resolution === "open" ? [failure] : [];
    });
    for (const failure of open) {
      signal?.throwIfAborted();
      const resolved = { ...failure, resolution: "resolved" as const, resolvedAt };
      await super.append(resolved);
      this.#remember(resolved);
    }
    return open.length;
  }

  public async retryEligibleFailureIds(now: Date, signal?: AbortSignal): Promise<Set<string>> {
    await this.initialize(signal);
    const ids = new Set<string>();
    for (const failure of this.#currentById.values()) {
      signal?.throwIfAborted();
      if (
        failure.phase === "download" &&
        failure.documentId !== undefined &&
        failure.retryable &&
        failure.resolution === "open" &&
        (failure.nextRetryAt === undefined || Date.parse(failure.nextRetryAt) <= now.getTime())
      ) {
        ids.add(failure.failureId);
      }
    }
    return ids;
  }

  public async initialize(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.#initialization === undefined) {
      this.#initialization = this.scan((failure) => {
        this.#remember(failure);
      }, signal).then(() => undefined);
      void this.#initialization.catch(() => {
        this.#initialization = undefined;
      });
    }
    await this.#initialization;
    signal?.throwIfAborted();
  }

  #remember(failure: ScrapeFailure): void {
    const previous = this.#currentById.get(failure.failureId);
    if (previous?.resolution === "open" && previous.documentId !== undefined) {
      const previousKey = documentKey(previous.phase, previous.documentId);
      const previousIds = this.#openByDocument.get(previousKey);
      previousIds?.delete(previous.failureId);
      if (previousIds?.size === 0) this.#openByDocument.delete(previousKey);
    }
    if (failure.resolution !== "open") {
      this.#currentById.delete(failure.failureId);
      this.#resolvedIds.add(failure.failureId);
      return;
    }
    this.#resolvedIds.delete(failure.failureId);
    this.#currentById.set(failure.failureId, failure);
    if (failure.documentId === undefined) return;
    const key = documentKey(failure.phase, failure.documentId);
    const ids = this.#openByDocument.get(key) ?? new Set<string>();
    ids.add(failure.failureId);
    this.#openByDocument.set(key, ids);
  }
}

function documentKey(phase: ScrapeFailure["phase"], documentId: string): string {
  return `${phase}\u0000${documentId}`;
}
