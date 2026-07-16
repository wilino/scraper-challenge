import type { DownloadManifestEvent } from "../models/download-manifest.js";
import type { ScrapedDocument } from "../models/document.js";

export interface DownloadCoverage {
  documents: number;
  announcesPdf: number;
  pending: number;
  downloaded: number;
  failed: number;
  noPdf: number;
  complete: boolean;
}

export class DownloadCoverageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DownloadCoverageError";
  }
}

export function reconcileDownloadCoverage(
  documents: readonly ScrapedDocument[],
  states: ReadonlyMap<string, DownloadManifestEvent>,
): DownloadCoverage {
  const unique = new Map<string, ScrapedDocument>();
  for (const document of documents) {
    if (unique.has(document.documentId)) {
      throw new DownloadCoverageError(`Documento duplicado: ${document.documentId}`);
    }
    unique.set(document.documentId, document);
  }
  const counts = { pending: 0, downloaded: 0, failed: 0, no_pdf: 0 };
  let announcesPdf = 0;
  for (const document of unique.values()) {
    if (document.pdf.state === "pending") announcesPdf += 1;
    const state = states.get(document.documentId);
    if (state === undefined) {
      throw new DownloadCoverageError(`Documento sin estado PDF: ${document.documentId}`);
    }
    counts[state.state] += 1;
    if (document.pdf.state === "pending" && state.state === "no_pdf") {
      throw new DownloadCoverageError(
        `Documento con PDF fue marcado no_pdf: ${document.documentId}`,
      );
    }
    if (document.pdf.state === "no_pdf" && state.state !== "no_pdf") {
      throw new DownloadCoverageError(`Documento sin PDF tiene estado ${state.state}`);
    }
  }
  for (const documentId of states.keys()) {
    if (!unique.has(documentId)) {
      throw new DownloadCoverageError(`Manifest contiene documento desconocido: ${documentId}`);
    }
  }
  const documentsCount = unique.size;
  const complete =
    documentsCount === counts.pending + counts.downloaded + counts.failed + counts.no_pdf &&
    announcesPdf === counts.pending + counts.downloaded + counts.failed;
  if (!complete) throw new DownloadCoverageError("Las invariantes de cobertura PDF no se cumplen");
  return {
    documents: documentsCount,
    announcesPdf,
    pending: counts.pending,
    downloaded: counts.downloaded,
    failed: counts.failed,
    noPdf: counts.no_pdf,
    complete,
  };
}
