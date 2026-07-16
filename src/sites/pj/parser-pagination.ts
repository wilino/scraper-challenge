import { load } from "cheerio";

import {
  PjStructuralError,
  type ParseResultsOptions,
  type PjListRecord,
  type PjPagination,
} from "./parser-types.js";
import { PJ_SELECTORS } from "./selectors.js";

function requirePositiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new PjStructuralError(`Estructura PJ inválida: ${label} ausente o inválido`);
  }
  return parsed;
}

export function paginationFrom(
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
