import type { CheerioAPI } from "cheerio";
import { load } from "cheerio";

import { findPdf } from "./parser-download.js";
import { addValue, clean, normalizeListMetadata } from "./parser-normalization.js";
import { PjStructuralError, type PjListRecord } from "./parser-types.js";
import { PJ_SELECTORS } from "./selectors.js";

type CheerioSelection = ReturnType<CheerioAPI>;

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

export function extractViewState(html: string): string {
  const $ = load(html);
  const value = $(PJ_SELECTORS.viewState).first().attr("value");
  if (value === undefined || value.trim() === "") {
    throw new PjStructuralError("Estructura PJ inválida: javax.faces.ViewState ausente");
  }
  return value;
}

export function parseTotals(text: string): {
  queryTotal?: number;
  publishedGlobalTotal?: number;
} {
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

function recordIndexFromId(id: string | undefined): number {
  const raw = /^formBuscador:repeat:(\d+):/u.exec(id ?? "")?.[1];
  const recordIndex = Number(raw);
  if (!Number.isInteger(recordIndex) || recordIndex < 0) {
    throw new PjStructuralError("Fila PJ sin índice nativo reconocible");
  }
  return recordIndex;
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

export function parseRecords(html: string, baseUrl: string): PjListRecord[] {
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
    const parsed: PjListRecord = {
      nativeId,
      recordIndex: recordIndexFromId(record.attr("id")),
      row,
      metadata,
      normalized: normalizeListMetadata(metadata),
      detail: { source, nativeId },
    };
    const pdf = findPdf(record, baseUrl);
    if (pdf !== undefined) parsed.pdf = pdf;
    records.push(parsed);
  });
  return records;
}
