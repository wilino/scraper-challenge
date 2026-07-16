import {
  downloadManifestEventSchema,
  type DownloadManifestEvent,
} from "../models/download-manifest.js";
import { JsonlStore } from "./jsonl-store.js";

export type DownloadResumeState =
  | {
      state: "downloaded";
      relativePath: string;
      sha256: string;
      bytes: number;
      effectiveUrl: string;
    }
  | { state: "failed"; failureId: string };

export type CompactDownloadState = "pending" | "no_pdf" | DownloadResumeState;

export class DownloadManifestStore extends JsonlStore<DownloadManifestEvent> {
  public constructor(filePath: string) {
    super(filePath, downloadManifestEventSchema);
  }

  public async currentStates(
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, DownloadManifestEvent>> {
    const current = new Map<string, DownloadManifestEvent>();
    await this.scan((event) => {
      current.set(event.documentId, event);
    }, signal);
    return current;
  }

  public async documentIds(signal?: AbortSignal): Promise<Set<string>> {
    const ids = new Set<string>();
    await this.scan((event) => {
      ids.add(event.documentId);
    }, signal);
    return ids;
  }

  public async compactStates(signal?: AbortSignal): Promise<Map<string, CompactDownloadState>> {
    const states = new Map<string, CompactDownloadState>();
    await this.scan((event) => {
      states.set(event.documentId, compactState(event));
    }, signal);
    return states;
  }
}

export function compactState(event: DownloadManifestEvent): CompactDownloadState {
  if (event.state === "pending" || event.state === "no_pdf") return event.state;
  if (event.state === "failed") return { state: event.state, failureId: event.failureId };
  return {
    state: event.state,
    relativePath: event.relativePath,
    sha256: event.sha256,
    bytes: event.bytes,
    effectiveUrl: event.effectiveUrl,
  };
}
