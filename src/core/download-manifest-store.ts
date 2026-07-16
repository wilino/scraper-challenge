import {
  downloadManifestEventSchema,
  type DownloadManifestEvent,
} from "../models/download-manifest.js";
import { JsonlStore } from "./jsonl-store.js";

export class DownloadManifestStore extends JsonlStore<DownloadManifestEvent> {
  public constructor(filePath: string) {
    super(filePath, downloadManifestEventSchema);
  }

  public async currentStates(): Promise<ReadonlyMap<string, DownloadManifestEvent>> {
    const { records } = await this.readAll();
    const current = new Map<string, DownloadManifestEvent>();
    for (const event of records) current.set(event.documentId, event);
    return current;
  }
}
