import { load } from "cheerio";

import type { OrderedPairs } from "../../models/http-request.js";

export const HISTORICAL_FORM_ID = "formBusqueda";
export const HISTORICAL_SEARCH_PATH =
  "/jurisprudenciaweb/faces/page/resolucion-busqueda-especializada-superior.xhtml";

function replaceOrAppend(payload: OrderedPairs, name: string, value: string): void {
  const first = payload.findIndex(([key]) => key === name);
  if (first < 0) {
    payload.push([name, value]);
    return;
  }
  payload[first] = [name, value];
  for (let index = payload.length - 1; index > first; index -= 1) {
    if (payload[index]?.[0] === name) payload.splice(index, 1);
  }
}

function semanticSubmit(html: string): OrderedPairs {
  const $ = load(html);
  const buttons = $(`form#${HISTORICAL_FORM_ID}`)
    .find('input[type="submit"], input[type="image"], button')
    .toArray();
  for (const element of buttons) {
    const button = $(element);
    const onclick = (button.attr("onclick") ?? "").replace(/\\(["'])/gu, "$1");
    if (!/["']forward["']\s*:\s*["']buscar["']/u.test(onclick)) continue;
    if (!/["']busqueda["']\s*:\s*["']especializada["']/u.test(onclick)) continue;
    const name = button.attr("name");
    if (name === undefined || name === "") continue;
    const result: OrderedPairs = [[name, button.attr("value") ?? name]];
    const object = /\{([\s\S]*?["']forward["'][\s\S]*?)\}/u.exec(onclick)?.[1] ?? "";
    for (const match of object.matchAll(/["']([^"']+)["']\s*:\s*["']([^"']*)["']/gu)) {
      const key = match[1];
      const value = match[2];
      if (key !== undefined && value !== undefined && key !== name) result.push([key, value]);
    }
    return result;
  }
  throw new Error("Botón semántico de búsqueda histórica ausente");
}

export function historicalSearchPayload(
  html: string,
  successfulControls: readonly (readonly [string, string])[],
): OrderedPairs {
  const $ = load(html);
  const payload: OrderedPairs = successfulControls.map(([name, value]) => [name, value]);
  replaceOrAppend(payload, HISTORICAL_FORM_ID, HISTORICAL_FORM_ID);
  replaceOrAppend(payload, `${HISTORICAL_FORM_ID}:txtBusqueda`, "");
  const fixed = [
    ["cmbCorte", "2"],
    ["cmbInstancia", "2"],
    ["cmbEspecialidad", "2"],
  ] as const;
  for (const [suffix, value] of fixed) {
    replaceOrAppend(payload, `${HISTORICAL_FORM_ID}:${suffix}`, value);
    const label = $(`[name="${HISTORICAL_FORM_ID}:${suffix}Input"]`).attr("value");
    if (label !== undefined) {
      replaceOrAppend(payload, `${HISTORICAL_FORM_ID}:${suffix}Input`, label);
    }
  }
  replaceOrAppend(payload, `${HISTORICAL_FORM_ID}:buAnio`, "");
  const yearLabel = $(`[name="${HISTORICAL_FORM_ID}:buAnioInput"]`).attr("value");
  if (yearLabel !== undefined) {
    replaceOrAppend(payload, `${HISTORICAL_FORM_ID}:buAnioInput`, yearLabel);
  }
  payload.push(...semanticSubmit(html));
  return payload;
}

export function historicalPageControls(source: string, page: number): OrderedPairs {
  if (!source.startsWith(`${HISTORICAL_FORM_ID}:`) || source.includes("\n")) {
    throw new Error("Source histórico de paginación inválido");
  }
  if (!Number.isInteger(page) || page < 1) throw new Error("Página histórica inválida");
  return [
    ["javax.faces.source", source],
    ["javax.faces.partial.event", "click"],
    ["javax.faces.partial.execute", `${source} @component`],
    ["javax.faces.partial.render", "@component"],
    [`${source}:page`, String(page)],
    ["org.richfaces.ajax.component", source],
    [source, source],
    ["AJAX:EVENTS_COUNT", "1"],
    ["javax.faces.partial.ajax", "true"],
  ];
}

export function encodeHistoricalPayload(payload: OrderedPairs): string {
  const encoded = new URLSearchParams();
  for (const [name, value] of payload) encoded.append(name, value);
  return encoded.toString();
}
