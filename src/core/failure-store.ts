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

  public async upsertOpenForDocument(
    value: ScrapeFailure,
    signal?: AbortSignal,
  ): Promise<ScrapeFailure> {
    await this.initialize(signal);
    const failure = scrapeFailureSchema.parse(value);
    if (failure.resolution !== "open" || failure.documentId === undefined) {
      throw new Error("El pendiente lógico requiere documentId y resolución open");
    }
    const key = documentKey(failure.phase, failure.documentId);
    const openIds = [...(this.#openByDocument.get(key) ?? [])].sort();
    const canonicalId = openIds[0];
    for (const duplicateId of openIds.slice(1)) {
      signal?.throwIfAborted();
      const duplicate = this.#currentById.get(duplicateId);
      if (duplicate === undefined) continue;
      const resolved = {
        ...duplicate,
        resolution: "resolved" as const,
        resolvedAt: failure.occurredAt,
      };
      await super.append(resolved);
      this.#remember(resolved);
    }
    const current = canonicalId === undefined ? failure : { ...failure, failureId: canonicalId };
    signal?.throwIfAborted();
    await super.append(current);
    this.#remember(current);
    return current;
  }

  public async currentFailures(
    phase?: ScrapeFailure["phase"],
    signal?: AbortSignal,
  ): Promise<ScrapeFailure[]> {
    await this.initialize(signal);
    return [...this.#currentById.values()]
      .filter((failure) => phase === undefined || failure.phase === phase)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  }

  public async retryEligibleFailures(
    phase: ScrapeFailure["phase"],
    now: Date,
    signal?: AbortSignal,
  ): Promise<ScrapeFailure[]> {
    return await this.#retryCandidates(phase, now, false, signal);
  }

  public async retryEligibleDetailFailures(
    now: Date,
    signal?: AbortSignal,
  ): Promise<ScrapeFailure[]> {
    return await this.#retryCandidates("detail", now, true, signal);
  }

  async #retryCandidates(
    phase: ScrapeFailure["phase"],
    now: Date,
    includeNonRetryable: boolean,
    signal?: AbortSignal,
  ): Promise<ScrapeFailure[]> {
    await this.initialize(signal);
    const failures: ScrapeFailure[] = [];
    for (const failure of this.#currentById.values()) {
      signal?.throwIfAborted();
      if (
        failure.phase === phase &&
        failure.documentId !== undefined &&
        (includeNonRetryable || failure.retryable) &&
        failure.resolution === "open" &&
        (failure.nextRetryAt === undefined || Date.parse(failure.nextRetryAt) <= now.getTime())
      ) {
        failures.push(failure);
      }
    }
    return failures.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  }

  public async retryEligibleFailureIds(now: Date, signal?: AbortSignal): Promise<Set<string>> {
    return new Set(
      (await this.retryEligibleFailures("download", now, signal)).map(({ failureId }) => failureId),
    );
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
