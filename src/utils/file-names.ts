import path from "node:path";

import type { ScrapedDocument } from "../models/document.js";

const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function safeSegment(value: string, fallback: string, maxLength: number): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/\p{Cc}/gu, "")
    .replace(/[\\/:*?"<>|]/gu, "-")
    .replace(/\.\.+/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[.\s-]+|[.\s-]+$/gu, "")
    .slice(0, maxLength);
  if (normalized === "" || RESERVED_WINDOWS_NAME.test(normalized)) return fallback;
  return normalized;
}

export function pdfFileName(document: ScrapedDocument): string {
  const date = safeSegment(document.resolutionDate ?? "", "sin-fecha", 32);
  const human = safeSegment(
    document.resolutionNumber ?? document.caseNumber ?? document.title ?? "",
    "documento",
    96,
  );
  return `${document.documentId}__${date}__${human}.pdf`;
}

export function resolvePdfPath(outputDir: string, fileName: string): string {
  const pdfDir = path.resolve(outputDir, "pdf");
  const candidate = path.resolve(pdfDir, fileName);
  if (path.dirname(candidate) !== pdfDir) throw new Error("La ruta PDF escapa de OUTPUT_DIR/pdf");
  return candidate;
}

export function relativeOutputPath(outputDir: string, filePath: string): string {
  const relative = path.relative(path.resolve(outputDir), path.resolve(filePath));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("La ruta PDF no pertenece a OUTPUT_DIR");
  }
  return relative.split(path.sep).join("/");
}
