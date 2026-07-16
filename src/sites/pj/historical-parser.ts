import { createHash } from "node:crypto";

import { load, type CheerioAPI } from "cheerio";

import { PJ_ORIGIN } from "../../config/defaults.js";
import { parseJsfPartialResponse } from "../../core/jsf/partial-response-parser.js";
import { httpRequestSpecSchema, type HttpRequestSpec } from "../../models/http-request.js";

const VIEW_STATE = "javax.faces.ViewState";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface PjHistoricalRecord {
  nativeId: string;
  row: number;
  pdf: HttpRequestSpec;
  metadata: Record<string, string[]>;
}

export interface PjHistoricalParsedResults {
  viewState: string;
  queryTotal: number;
  publishedGlobalTotal: null;
  records: PjHistoricalRecord[];
  pagination: {
    currentPage: number;
    maxPages: number;
    pageSize: number;
    hasNext: boolean;
    hasLast: boolean;
    endSignal: "more" | "natural_end";
  };
  fingerprint: string;
  scrollerSource: string;
}

export interface ParseHistoricalOptions {
  baseUrl?: string;
  currentPage?: number;
  queryTotal?: number;
  pageSize?: number;
}

export class PjHistoricalStructuralError extends Error {
  readonly code = "PJ_STRUCTURAL_CHANGE";

  constructor(message: string) {
    super(message);
    this.name = "PjHistoricalStructuralError";
  }
}

function clean(value: string): string {
  return value
    .replace(/\u00a0/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function unwrap(body: string): { html: string; viewState?: string } {
  if (!/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<partial-response[\s>]/iu.test(body))
    return { html: body };
  const partial = parseJsfPartialResponse(body);
  if (partial.error !== undefined || partial.redirectUrl !== undefined) {
    throw new PjHistoricalStructuralError("Respuesta parcial histórica inesperada");
  }
  const viewState = partial.updates.get(VIEW_STATE)?.trim();
  const fragments = [...partial.updates]
    .filter(([id]) => id !== VIEW_STATE)
    .map(([, html]) => html)
    .join("\n");
  if (viewState === undefined || viewState === "" || fragments === "") {
    throw new PjHistoricalStructuralError("Respuesta parcial histórica incompleta");
  }
  return { html: fragments, viewState };
}

function parseQueryTotal($: CheerioAPI, fallback: number | undefined): number {
  const candidates = $("[id]")
    .filter((_index, element) => /(?:resultado|result)/iu.test($(element).attr("id") ?? ""))
    .toArray()
    .map((element) => clean($(element).text()));
  candidates.push(clean($("body").text()));
  for (const text of candidates) {
    const match = /([\d.,]+)\s+resultados?/iu.exec(text)?.[1];
    if (match !== undefined) return Number(match.replace(/[.,]/gu, ""));
  }
  if (fallback !== undefined) return fallback;
  throw new PjHistoricalStructuralError("Total histórico ausente");
}

function isPdfLink($: CheerioAPI, element: Parameters<CheerioAPI>[0]): boolean {
  const link = $(element);
  const semantic = [
    link.attr("title") ?? "",
    link.attr("data-file-type") ?? "",
    clean(link.text()),
    link.find("img,input").attr("src") ?? "",
    link.find("img").attr("alt") ?? "",
    link.find("img").attr("title") ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return semantic.includes("pdf") || semantic.includes("btn-ver-resolucion");
}

function downloadUuid(href: string, baseUrl: string): { uuid: string; request: HttpRequestSpec } {
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch {
    throw new PjHistoricalStructuralError("URL histórica de descarga inválida");
  }
  const uuid = url.searchParams.get("uuid")?.toLowerCase();
  if (uuid === undefined || !UUID_PATTERN.test(uuid)) {
    throw new PjHistoricalStructuralError("Descarga histórica sin UUID válido");
  }
  const parsed = httpRequestSpecSchema.safeParse({ method: "GET", url: url.href });
  if (!parsed.success) throw new PjHistoricalStructuralError("Descarga histórica no permitida");
  return { uuid, request: parsed.data };
}

function parseRecords($: CheerioAPI, baseUrl: string): PjHistoricalRecord[] {
  const candidates = $('a[href*="ServletDescarga"]')
    .toArray()
    .filter((element) => isPdfLink($, element));
  const seen = new Set<string>();
  const records: PjHistoricalRecord[] = [];
  for (const element of candidates) {
    const href = $(element).attr("href");
    if (href === undefined) continue;
    const { uuid, request } = downloadUuid(href, baseUrl);
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    const container = $(element).closest('[id*="repeat"], [id*="tabla"], tr, .row').first();
    const sourceText = clean(
      container.length === 0 ? $(element).parent().text() : container.text(),
    );
    records.push({
      nativeId: uuid,
      row: records.length,
      pdf: request,
      metadata: sourceText === "" ? {} : { historicalRow: [sourceText] },
    });
  }
  return records;
}

function integerProperty(source: string, property: string): number | undefined {
  const raw = new RegExp(`["']?${property}["']?\\s*:\\s*(\\d+)`, "u").exec(source)?.[1];
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function pagination(
  $: CheerioAPI,
  html: string,
  total: number,
  records: readonly PjHistoricalRecord[],
  options: ParseHistoricalOptions,
): PjHistoricalParsedResults["pagination"] & { scrollerSource: string } {
  let source: string | undefined;
  let scriptConfig = "";
  for (const script of $("script").toArray()) {
    const text = $(script).text();
    const match =
      /new\s+RichFaces\.ui\.DataScroller\(\s*["']([^"']+)["']\s*,\s*\{([\s\S]*?)\}\s*\)/u.exec(
        text,
      );
    if (match?.[1] !== undefined) {
      source = match[1];
      scriptConfig = match[2] ?? "";
      break;
    }
  }
  source ??= $("[id]")
    .filter((_index, element) => /(?:data|page|scroll)/iu.test($(element).attr("id") ?? ""))
    .filter((_index, element) => /currentPage|maxValue/u.test($(element).text()))
    .first()
    .attr("id");
  if (source === undefined) {
    const ajaxSource = /javax\.faces\.source['"]?\s*[:,=]\s*['"]([^'"]+)/u.exec(html)?.[1];
    source = ajaxSource;
  }
  if (source === undefined) throw new PjHistoricalStructuralError("Paginador histórico ausente");

  const pageSize = options.pageSize ?? 5;
  const element = $("[id]")
    .filter((_index, item) => $(item).attr("id") === source)
    .first();
  const elementText = `${element.attr("data-current-page") ?? ""} ${element.attr("data-max-value") ?? ""} ${element.text()}`;
  const currentPage =
    integerProperty(scriptConfig, "currentPage") ??
    (Number(element.attr("data-current-page")) || undefined) ??
    integerProperty(elementText, "currentPage") ??
    options.currentPage ??
    1;
  const maxPages =
    integerProperty(scriptConfig, "maxValue") ??
    (Number(element.attr("data-max-value")) || undefined) ??
    integerProperty(elementText, "maxValue") ??
    Math.max(1, Math.ceil(total / pageSize));
  if (!Number.isInteger(currentPage) || currentPage < 1 || currentPage > maxPages) {
    throw new PjHistoricalStructuralError("Estado de página histórica inválido");
  }
  const hasNext =
    $("[id]").filter((_index, item) => $(item).attr("id") === `${source}_ds_next`).length > 0;
  const hasLast =
    $("[id]").filter((_index, item) => $(item).attr("id") === `${source}_ds_l`).length > 0;
  const naturalEnd = currentPage === maxPages && records.length >= 1 && records.length <= pageSize;
  return {
    currentPage,
    maxPages,
    pageSize,
    hasNext,
    hasLast,
    endSignal: naturalEnd ? "natural_end" : "more",
    scrollerSource: source,
  };
}

export function parseHistoricalResults(
  body: string,
  options: ParseHistoricalOptions = {},
): PjHistoricalParsedResults {
  const response = unwrap(body);
  const $ = load(response.html);
  const queryTotal = parseQueryTotal($, options.queryTotal);
  const records = parseRecords($, options.baseUrl ?? PJ_ORIGIN);
  if (queryTotal > 0 && records.length === 0) {
    throw new PjHistoricalStructuralError(
      "Página histórica con resultados pero sin PDF identificable",
    );
  }
  const viewState =
    response.viewState ?? $('input[name="javax.faces.ViewState"]').first().attr("value")?.trim();
  if (viewState === undefined || viewState === "") {
    throw new PjHistoricalStructuralError("ViewState histórico ausente");
  }
  const parsedPagination = pagination($, response.html, queryTotal, records, options);
  const { scrollerSource, ...page } = parsedPagination;
  return {
    viewState,
    queryTotal,
    publishedGlobalTotal: null,
    records,
    pagination: page,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(records.map(({ nativeId }) => nativeId)))
      .digest("hex"),
    scrollerSource,
  };
}
