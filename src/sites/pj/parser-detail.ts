import { load } from "cheerio";

import { PJ_ORIGIN } from "../../config/defaults.js";
import { findPdf, findWordUrl } from "./parser-download.js";
import { addValue, clean } from "./parser-normalization.js";
import { PARTIAL_RESPONSE_PATTERN, parsePartialResponse } from "./parser-partial.js";
import {
  PjStructuralError,
  type MergedPjRecord,
  type PjListRecord,
  type PjParsedDetail,
} from "./parser-types.js";
import {
  DETAIL_LABEL_ALIASES,
  DETAIL_POPUP_BY_COURT,
  PJ_SELECTORS,
  PJ_VIEW_STATE,
  type PjCourt,
} from "./selectors.js";

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
  const wordUrl = findWordUrl(popup, baseUrl);
  if (wordUrl !== undefined) parsed.wordUrl = wordUrl;
  return parsed;
}

export function mergeListAndDetail(record: PjListRecord, detail: PjParsedDetail): MergedPjRecord {
  const merged: MergedPjRecord = {
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
