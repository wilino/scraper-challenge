import type { HttpRequestSpec } from "../../models/index.js";
import type { PjCourt } from "./selectors.js";

export class PjStructuralError extends Error {
  readonly code = "PJ_STRUCTURAL_CHANGE";

  constructor(message: string) {
    super(message);
    this.name = "PjStructuralError";
  }
}

export interface PjDetailDescriptor {
  source: string;
  nativeId: string;
}

export interface PjListRecord {
  nativeId: string;
  recordIndex: number;
  row: number;
  metadata: Record<string, string[]>;
  normalized: Record<string, string>;
  detail: PjDetailDescriptor;
  pdf?: HttpRequestSpec;
}

export interface PjPagination {
  currentPage: number;
  maxPages: number;
  pageSize: number;
  hasNext: boolean;
  hasLast: boolean;
  endSignal: "more" | "natural_end";
}

export interface PjParsedResults {
  viewState: string;
  queryTotal: number;
  publishedGlobalTotal: number | null;
  records: PjListRecord[];
  pagination: PjPagination;
  fingerprint: string;
}

export interface ParseResultsOptions {
  pageSize?: number;
  currentPage?: number;
  queryTotal?: number;
  publishedGlobalTotal?: number | null;
  previousViewState?: string;
  requireChangedViewState?: boolean;
  baseUrl?: string;
}

export interface PjParsedDetail {
  court: PjCourt;
  popupId: string;
  viewState?: string;
  metadata: Record<string, string[]>;
  normalized: Record<string, string[]>;
  unknownFields: Record<string, string[]>;
  warnings: string[];
  pdf?: HttpRequestSpec;
  wordUrl?: string;
}

export type PjPartialResponse =
  | { kind: "updates"; updates: ReadonlyMap<string, string> }
  | { kind: "redirect"; url: string }
  | { kind: "error"; name: string; message: string };

export interface MergedPjRecord {
  metadata: {
    list: Record<string, string[]>;
    detail: Record<string, string[]>;
    unknownFields: Record<string, string[]>;
  };
  normalized: Record<string, string | string[]>;
  pdf?: HttpRequestSpec;
  wordUrl?: string;
}
