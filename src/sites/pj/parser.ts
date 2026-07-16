import { createHash } from "node:crypto";

import { load, type CheerioAPI } from "cheerio";

import { PJ_ORIGIN } from "../../config/defaults.js";
import {
  httpRequestSpecSchema,
  type HttpRequestSpec,
  type OrderedPairs,
} from "../../models/index.js";
import {
  DETAIL_LABEL_ALIASES,
  DETAIL_POPUP_BY_COURT,
  PJ_SELECTORS,
  PJ_VIEW_STATE,
  type PjCourt,
} from "./selectors.js";

type CheerioSelection = ReturnType<CheerioAPI>;

const PARTIAL_RESPONSE_PATTERN =
  /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<partial-response[\s>]/iu;

const LIST_NORMALIZED_FIELDS = {
  recurso: "title",
  nroexp: "caseNumber",
  tipoResolucion: "resolutionType",
  fechaResolucion: "resolutionDate",
  sumilla: "summary",
} as const;

const LIVE_LIST_LABEL_FIELDS: Readonly<Record<string, string>> = {
  "Pretensión/Delito": "pretensiones",
  "Tipo Resolución": "tipoResolucion",
  "Fecha Resolución": "fechaResolucion",
  "Sala Suprema": "sala",
  Sala: "sala",
  "Norma de Derecho Interno": "normaDI",
  Sumilla: "sumilla",
  "Palabras Clave": "palabras",
};

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
  parameters: OrderedPairs;
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

function clean(value: string): string {
  return value
    .replace(/\u00a0/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function requirePositiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new PjStructuralError(`Estructura PJ inválida: ${label} ausente o inválido`);
  }
  return parsed;
}

function addValue(target: Record<string, string[]>, key: string, value: string): void {
  const values = target[key] ?? [];
  values.push(value);
  target[key] = values;
}

function extractViewState(html: string): string {
  const $ = load(html);
  const value = $(PJ_SELECTORS.viewState).first().attr("value");
  if (value === undefined || value.trim() === "") {
    throw new PjStructuralError("Estructura PJ inválida: javax.faces.ViewState ausente");
  }
  return value;
}

function parseTotals(text: string): { queryTotal?: number; publishedGlobalTotal?: number } {
  const normalized = clean(text);
  const complete =
    /total de\s+([\d.,]+)\s+resoluciones.*?obtuvieron\s+([\d.,]+)\s+resultados/iu.exec(normalized);
  if (complete?.[1] !== undefined && complete[2] !== undefined) {
    return {
      publishedGlobalTotal: Number(complete[1].replace(/[.,]/gu, "")),
      queryTotal: Number(complete[2].replace(/[.,]/gu, "")),
    };
  }
  const result = /([\d.,]+)\s+resultados/iu.exec(normalized)?.[1];
  return result === undefined ? {} : { queryTotal: Number(result.replace(/[.,]/gu, "")) };
}

function strictDownloadRequest(href: string, baseUrl: string): HttpRequestSpec {
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch {
    throw new PjStructuralError("Descriptor de descarga PJ contiene una URL inválida");
  }
  const parsed = httpRequestSpecSchema.safeParse({ method: "GET", url: url.href });
  if (!parsed.success) {
    throw new PjStructuralError("Descriptor de descarga PJ no es un ServletDescarga seguro");
  }
  return parsed.data;
}

function findPdf(root: CheerioSelection, baseUrl: string): HttpRequestSpec | undefined {
  const link = root
    .find('a[data-file-type="pdf"], a[href*="ServletDescarga"]')
    .filter((_index, element) => {
      const anchor = root.find(element);
      const type = anchor.attr("data-file-type")?.toLowerCase();
      const icon = anchor.find("img, input").attr("src")?.toLowerCase() ?? "";
      return type === "pdf" || clean(anchor.text()).toLowerCase() === "pdf" || icon.includes("pdf");
    })
    .first();
  const href = link.attr("href");
  return href === undefined ? undefined : strictDownloadRequest(href, baseUrl);
}

function recordIndexFromId(id: string | undefined): number {
  const raw = /^formBuscador:repeat:(\d+):/u.exec(id ?? "")?.[1];
  const recordIndex = Number(raw);
  if (!Number.isInteger(recordIndex) || recordIndex < 0) {
    throw new PjStructuralError("Fila PJ sin índice nativo reconocible");
  }
  return recordIndex;
}

function recordParameters(metadata: Record<string, string[]>, nativeId: string): OrderedPairs {
  const value = (field: string): string => metadata[field]?.[0] ?? "";
  return [
    ["uuid", nativeId],
    ["recurso", value("recurso")],
    ["nroexp", value("nroexp")],
    ["palabras", value("palabras")],
    ["pretensiones", value("pretensiones")],
    ["normaDI", value("normaDI")],
    ["tipoResolucion", value("tipoResolucion")],
    ["fechaResolucion", value("fechaResolucion")],
    ["sala", value("sala")],
    ["sumilla", value("sumilla")],
  ];
}

function parseLiveListMetadata(record: CheerioSelection): Record<string, string[]> {
  const metadata: Record<string, string[]> = {};
  const headerValues = record
    .find('[id$="_header"] span')
    .toArray()
    .map((element) => clean(record.find(element).text()));
  if (headerValues[0] !== undefined) addValue(metadata, "recurso", headerValues[0]);
  if (headerValues[1] !== undefined) addValue(metadata, "nroexp", headerValues[1]);
  record.find(".marginb").each((_index, group) => {
    const label = clean(record.find(group).find(".txtbold").first().text()).replace(/:\s*$/u, "");
    if (label === "") return;
    const value = clean(
      record
        .find(group)
        .find(".col-md-12")
        .filter((_fieldIndex, field) => !record.find(field).hasClass("txtbold"))
        .first()
        .text(),
    );
    addValue(metadata, LIVE_LIST_LABEL_FIELDS[label] ?? label, value);
  });
  return metadata;
}

function nativeIdFromDetailLink(detailLink: CheerioSelection): string | undefined {
  const nativeId = detailLink.attr("data-uuid");
  if (nativeId !== undefined) return nativeId;
  const onclick = (detailLink.attr("onclick") ?? "").replace(/\\+u002d/giu, "-");
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu.exec(onclick)?.[0];
}

function parseRecords(html: string, baseUrl: string): PjListRecord[] {
  const $ = load(html);
  const records: PjListRecord[] = [];
  $(PJ_SELECTORS.resultRecords).each((row, element) => {
    const record = $(element);
    const metadata: Record<string, string[]> = {};
    record.find(PJ_SELECTORS.listField).each((_index, field) => {
      const name = $(field).attr("data-field");
      if (name !== undefined) addValue(metadata, name, clean($(field).text()));
    });
    if (Object.keys(metadata).length === 0) Object.assign(metadata, parseLiveListMetadata(record));
    if (Object.keys(metadata).length === 0) {
      throw new PjStructuralError("Fila PJ sin campos data-field");
    }

    const detailLink = record.find(PJ_SELECTORS.detailLink).first();
    const nativeId = nativeIdFromDetailLink(detailLink);
    const source = detailLink.attr("id");
    if (nativeId === undefined || source === undefined) {
      throw new PjStructuralError("Fila PJ sin descriptor de detalle completo");
    }
    const normalized: Record<string, string> = {};
    for (const [field, normalizedName] of Object.entries(LIST_NORMALIZED_FIELDS)) {
      const value = metadata[field]?.[0];
      if (value !== undefined && value !== "") normalized[normalizedName] = value;
    }

    const parsed: PjListRecord = {
      nativeId,
      recordIndex: recordIndexFromId(record.attr("id")),
      row,
      metadata,
      normalized,
      detail: { source, nativeId, parameters: recordParameters(metadata, nativeId) },
    };
    const pdf = findPdf(record, baseUrl);
    if (pdf !== undefined) parsed.pdf = pdf;
    records.push(parsed);
  });
  return records;
}

function unwrapResultsResponse(body: string): { html: string; viewState?: string } {
  if (!PARTIAL_RESPONSE_PATTERN.test(body)) return { html: body };
  const partial = parsePartialResponse(body);
  if (partial.kind === "redirect") {
    throw new PjStructuralError(
      `Respuesta parcial PJ redirigió a ${partial.url}; requiere rebootstrap`,
    );
  }
  if (partial.kind === "error") {
    throw new PjStructuralError(`Error parcial PJ ${partial.name}: ${partial.message}`);
  }
  const panel = partial.updates.get("formBuscador:panel");
  const scroller = partial.updates.get("formBuscador:data1");
  const viewState = partial.updates.get(PJ_VIEW_STATE);
  if (
    panel === undefined ||
    scroller === undefined ||
    viewState === undefined ||
    clean(viewState) === ""
  ) {
    throw new PjStructuralError(
      "Respuesta parcial PJ incompleta: panel, paginador o ViewState ausente",
    );
  }
  return { html: `${scroller}${panel}`, viewState: clean(viewState) };
}

function paginationFrom(
  html: string,
  records: PjListRecord[],
  total: number,
  options: ParseResultsOptions,
): PjPagination {
  const $ = load(html);
  const pageSize = options.pageSize ?? 10;
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("pageSize debe ser positivo");
  const scroller = $(PJ_SELECTORS.dataScroller).first();
  const inferredMaxPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage =
    scroller.length === 0
      ? (options.currentPage ?? 1)
      : requirePositiveInteger(
          scroller.attr("data-current-page") ??
            /["']?currentPage["']?\s*:\s*(\d+)/u.exec(scroller.text())?.[1] ??
            String(options.currentPage ?? 1),
          "currentPage",
        );
  const maxPages =
    scroller.length === 0
      ? inferredMaxPages
      : requirePositiveInteger(
          scroller.attr("data-max-value") ??
            /["']?maxValue["']?\s*:\s*(\d+)/u.exec(scroller.text())?.[1] ??
            String(inferredMaxPages),
          "maxValue",
        );
  if (currentPage > maxPages) {
    throw new PjStructuralError("Paginador PJ inválido: currentPage supera maxValue");
  }
  const hasNext = $(PJ_SELECTORS.nextPage).length > 0;
  const hasLast = $(PJ_SELECTORS.lastPage).length > 0;
  const validLastRows = records.length >= 1 && records.length <= pageSize;
  const naturalEnd = currentPage === maxPages && !hasNext && !hasLast && validLastRows;
  return {
    currentPage,
    maxPages,
    pageSize,
    hasNext,
    hasLast,
    endSignal: naturalEnd ? "natural_end" : "more",
  };
}

export function parseResultsPage(body: string, options: ParseResultsOptions = {}): PjParsedResults {
  const response = unwrapResultsResponse(body);
  const $ = load(response.html);
  const totals = parseTotals($(PJ_SELECTORS.resultSummary).text());
  const queryTotal = totals.queryTotal ?? options.queryTotal;
  if (queryTotal === undefined || !Number.isInteger(queryTotal) || queryTotal < 0) {
    throw new PjStructuralError("Estructura PJ inválida: total de resultados ausente");
  }
  const records = parseRecords(response.html, options.baseUrl ?? PJ_ORIGIN);
  if (queryTotal > 0 && records.length === 0) {
    throw new PjStructuralError("Estructura PJ inválida: página con resultados pero sin filas");
  }
  const viewState = response.viewState ?? extractViewState(body);
  if (
    options.requireChangedViewState === true &&
    options.previousViewState !== undefined &&
    viewState === options.previousViewState
  ) {
    throw new PjStructuralError("Respuesta PJ reutilizó el ViewState anterior");
  }
  const pagination = paginationFrom(response.html, records, queryTotal, options);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(records.map(({ nativeId, metadata }) => ({ nativeId, metadata }))))
    .digest("hex");
  return {
    viewState,
    queryTotal,
    publishedGlobalTotal: totals.publishedGlobalTotal ?? options.publishedGlobalTotal ?? null,
    records,
    pagination,
    fingerprint,
  };
}

export function parsePartialResponse(xml: string): PjPartialResponse {
  const $ = load(xml, { xmlMode: true });
  const root = $("partial-response");
  if (root.length !== 1) throw new PjStructuralError("XML PJ no es un partial-response válido");
  const redirect = root.children("redirect").first();
  if (redirect.length > 0) {
    const url = redirect.attr("url");
    if (url === undefined || url === "") throw new PjStructuralError("Redirect parcial PJ sin URL");
    return { kind: "redirect", url };
  }
  const error = root.children("error").first();
  if (error.length > 0) {
    return {
      kind: "error",
      name: clean(error.find("error-name").text()) || "unknown",
      message: clean(error.find("error-message").text()),
    };
  }
  const updates = new Map<string, string>();
  root.find("changes > update").each((_index, update) => {
    const id = $(update).attr("id");
    if (id !== undefined) updates.set(id, $(update).text());
  });
  if (updates.size === 0) throw new PjStructuralError("Respuesta parcial PJ sin updates");
  return { kind: "updates", updates };
}

function parseWordUrl(root: CheerioSelection, baseUrl: string): string | undefined {
  const href = root
    .find('a[href*="ServletDescarga"]')
    .filter((_index, element) => {
      const anchor = root.find(element);
      const type = anchor.attr("data-file-type")?.toLowerCase();
      const icon = anchor.find("img, input").attr("src")?.toLowerCase() ?? "";
      return (
        type === "word" || clean(anchor.text()).toLowerCase() === "word" || icon.includes("word")
      );
    })
    .first()
    .attr("href");
  return href === undefined ? undefined : strictDownloadRequest(href, baseUrl).url;
}

export function parseDetail(
  body: string,
  court: PjCourt,
  baseUrl: string = PJ_ORIGIN,
): PjParsedDetail {
  let html = body;
  let viewState: string | undefined;
  if (PARTIAL_RESPONSE_PATTERN.test(body)) {
    const partial = parsePartialResponse(body);
    if (partial.kind !== "updates") {
      throw new PjStructuralError(`Detalle PJ parcial inesperado: ${partial.kind}`);
    }
    const popupId = DETAIL_POPUP_BY_COURT[court];
    html = partial.updates.get(popupId) ?? "";
    viewState = partial.updates.get(PJ_VIEW_STATE);
    if (html === "") {
      throw new PjStructuralError(`Detalle PJ sin panel esperado ${popupId}`);
    }
  }

  const $ = load(html);
  const popupId = DETAIL_POPUP_BY_COURT[court];
  const popup = $(`#${popupId.replace(/:/gu, "\\:")}`).first();
  if (popup.length !== 1) throw new PjStructuralError(`Detalle PJ sin popup ${popupId}`);

  const metadata: Record<string, string[]> = {};
  const normalized: Record<string, string[]> = {};
  const unknownFields: Record<string, string[]> = {};
  popup.find(PJ_SELECTORS.detailLabels).each((_index, labelElement) => {
    const label = clean($(labelElement).text()).replace(/:\s*$/u, "");
    const value = clean($(labelElement).next("dd").text());
    addValue(metadata, label, value);
    const semanticName = DETAIL_LABEL_ALIASES[label];
    if (semanticName === undefined) addValue(unknownFields, label, value);
    else addValue(normalized, semanticName, value);
  });
  if (Object.keys(metadata).length === 0) {
    popup.find(".panel-body .txtbold").each((_index, labelElement) => {
      const label = clean($(labelElement).text())
        .replace(/^\*+\s*/u, "")
        .replace(/:\s*$/u, "");
      if (label === "") return;
      const value = clean($(labelElement).next(".marginb2").find(".data").first().text());
      addValue(metadata, label, value);
      const semanticName = DETAIL_LABEL_ALIASES[label];
      if (semanticName === undefined) addValue(unknownFields, label, value);
      else addValue(normalized, semanticName, value);
    });
  }
  if (Object.keys(metadata).length === 0) {
    throw new PjStructuralError("Detalle PJ sin pares etiqueta/valor");
  }

  const warnings = Object.keys(unknownFields).map(
    (label) => `Etiqueta de detalle PJ no inventariada: ${label}`,
  );
  const parsed: PjParsedDetail = {
    court,
    popupId,
    metadata,
    normalized,
    unknownFields,
    warnings,
  };
  if (viewState !== undefined && clean(viewState) !== "") parsed.viewState = clean(viewState);
  const pdf = findPdf(popup, baseUrl);
  if (pdf !== undefined) parsed.pdf = pdf;
  const wordUrl = parseWordUrl(popup, baseUrl);
  if (wordUrl !== undefined) parsed.wordUrl = wordUrl;
  return parsed;
}

export function mergeListAndDetail(
  record: PjListRecord,
  detail: PjParsedDetail,
): {
  metadata: {
    list: Record<string, string[]>;
    detail: Record<string, string[]>;
    unknownFields: Record<string, string[]>;
  };
  normalized: Record<string, string | string[]>;
  pdf?: HttpRequestSpec;
  wordUrl?: string;
} {
  const merged: {
    metadata: {
      list: Record<string, string[]>;
      detail: Record<string, string[]>;
      unknownFields: Record<string, string[]>;
    };
    normalized: Record<string, string | string[]>;
    pdf?: HttpRequestSpec;
    wordUrl?: string;
  } = {
    metadata: {
      list: record.metadata,
      detail: detail.metadata,
      unknownFields: detail.unknownFields,
    },
    normalized: { ...record.normalized, ...detail.normalized },
  };
  const pdf = detail.pdf ?? record.pdf;
  if (pdf !== undefined) merged.pdf = pdf;
  if (detail.wordUrl !== undefined) merged.wordUrl = detail.wordUrl;
  return merged;
}
