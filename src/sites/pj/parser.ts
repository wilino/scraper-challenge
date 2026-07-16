import { createHash } from "node:crypto";

import { load } from "cheerio";

import { PJ_ORIGIN } from "../../config/defaults.js";
import { extractViewState, parseRecords, parseTotals } from "./parser-list.js";
import { clean } from "./parser-normalization.js";
import { paginationFrom } from "./parser-pagination.js";
import { PARTIAL_RESPONSE_PATTERN, parsePartialResponse } from "./parser-partial.js";
import {
  PjStructuralError,
  type ParseResultsOptions,
  type PjParsedResults,
} from "./parser-types.js";
import { PJ_SELECTORS, PJ_VIEW_STATE } from "./selectors.js";

export { mergeListAndDetail, parseDetail } from "./parser-detail.js";
export { parsePartialResponse } from "./parser-partial.js";
export { PjStructuralError } from "./parser-types.js";
export type {
  ParseResultsOptions,
  PjDetailDescriptor,
  PjListRecord,
  PjPagination,
  PjParsedDetail,
  PjParsedResults,
  PjPartialResponse,
} from "./parser-types.js";

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
