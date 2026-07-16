import { createHash } from "node:crypto";

import { load, type CheerioAPI } from "cheerio";

import type { OrderedPairs } from "../../models/http-request.js";
import { PJ_FORM_ID, PJ_SELECTORS, type PjCourt } from "./selectors.js";

const DETAIL_PARAMETERS = [
  "uuid",
  "recurso",
  "nroexp",
  "palabras",
  "pretensiones",
  "normaDI",
  "tipoResolucion",
  "fechaResolucion",
  "sala",
  "sumilla",
] as const;

// Legacy PJ markup encoded the specialized action in this exact generated control.
// It is intentionally narrow: incidental values of "21" are only sort-order metadata.
const LEGACY_SPECIALIZED_MARKER: readonly [string, string] = [`${PJ_FORM_ID}:j_idt34`, "21"];

export interface SearchPayloadOptions {
  court: PjCourt;
  query?: string;
  mode?: "general" | "specialized";
  includeAutoQualifiers?: boolean;
}

export interface DetailRequestDescriptor {
  source: string;
  nativeId: string;
  parameters: OrderedPairs;
}

function formFrom(html: string): CheerioAPI {
  const $ = load(html);
  if ($(PJ_SELECTORS.form).length !== 1) {
    throw new Error(`Estructura PJ inválida: no se encontró un único form#${PJ_FORM_ID}`);
  }
  return $;
}

function selectedValues($: CheerioAPI, element: Parameters<CheerioAPI>[0]): string[] {
  const select = $(element);
  const selected = select.find("option:selected");
  const options = selected.length > 0 ? selected : select.find("option").first();
  return options.toArray().map((option) => $(option).attr("value") ?? $(option).text());
}

export function extractSuccessfulControls(html: string): OrderedPairs {
  const $ = formFrom(html);
  const controls: OrderedPairs = [];

  $(PJ_SELECTORS.form)
    .find("input, select, textarea")
    .each((_index, element) => {
      const control = $(element);
      const name = control.attr("name");
      if (name === undefined || control.is(":disabled")) return;

      if (element.tagName === "select") {
        for (const value of selectedValues($, element)) controls.push([name, value]);
        return;
      }
      if (element.tagName === "textarea") {
        controls.push([name, control.text()]);
        return;
      }

      const type = (control.attr("type") ?? "text").toLowerCase();
      if (["button", "file", "image", "reset", "submit"].includes(type)) return;
      if (["checkbox", "radio"].includes(type) && !control.is(":checked")) return;
      controls.push([name, control.attr("value") ?? (type === "checkbox" ? "on" : "")]);
    });

  return controls;
}

function replaceControl(controls: OrderedPairs, name: string, value: string): void {
  const index = controls.findIndex(([key]) => key === name);
  if (index < 0) throw new Error(`Control PJ requerido ausente: ${name}`);
  controls[index] = [name, value];
}

function extractSubmitParameters(
  $: CheerioAPI,
  mode: NonNullable<SearchPayloadOptions["mode"]>,
): OrderedPairs {
  const submits = $(PJ_SELECTORS.form)
    .find('input[type="image"], input[type="submit"]')
    .filter((_index, element) => {
      const onclick = ($(element).attr("onclick") ?? "").replace(/\\(['"])/gu, "$1");
      return /['"]forward['"]\s*:\s*['"]buscar['"]/u.test(onclick);
    })
    .toArray()
    .map((element) => parseSubmit($, element));
  if (submits.length === 0) throw new Error("Estructura PJ inválida: botón de búsqueda ausente");

  const explicit = submits.filter(({ role }) => role === mode);
  if (explicit.length === 1) return explicit[0]?.pairs ?? [];
  if (explicit.length > 1) throw new Error(`Estructura PJ inválida: submit ${mode} ambiguo`);

  const unclassified = submits.filter(({ role }) => role === undefined);
  const semanticallyClassified = submits.length - unclassified.length;
  if (semanticallyClassified > 0) {
    if (submits.length === 2 && unclassified.length === 1) return unclassified[0]?.pairs ?? [];
    throw new Error(`Estructura PJ inválida: submit ${mode} no identificado por rol`);
  }

  const legacySpecialized = submits.filter(({ pairs }) =>
    pairs.some(
      ([key, value]) =>
        key === LEGACY_SPECIALIZED_MARKER[0] && value === LEGACY_SPECIALIZED_MARKER[1],
    ),
  );
  if (legacySpecialized.length > 1) {
    throw new Error("Estructura PJ inválida: fallback specialized ambiguo");
  }
  if (legacySpecialized.length === 1) {
    if (mode === "specialized") return legacySpecialized[0]?.pairs ?? [];
    const general = submits.filter((submit) => submit !== legacySpecialized[0]);
    if (general.length === 1) return general[0]?.pairs ?? [];
  }
  if (mode === "general" && submits.length === 1) return submits[0]?.pairs ?? [];
  throw new Error(`Estructura PJ inválida: submit ${mode} no identificado por rol`);
}

function parseSubmit(
  $: CheerioAPI,
  element: Parameters<CheerioAPI>[0],
): { pairs: OrderedPairs; role: "general" | "specialized" | undefined } {
  const submit = $(element);
  const name = submit.attr("name");
  if (name === undefined) throw new Error("Estructura PJ inválida: submit sin nombre");
  const onclick = (submit.attr("onclick") ?? "").replace(/\\(['"])/gu, "$1");
  const objectMatch = /document\.getElementById\([^)]*\)\s*,\s*\{([\s\S]*?)\}\s*,/u.exec(onclick);
  if (objectMatch?.[1] === undefined) {
    throw new Error("Estructura PJ inválida: parámetros del botón de búsqueda ausentes");
  }
  const pairs: OrderedPairs = [[name, name]];
  const pairPattern = /['"]([^'"]+)['"]\s*:\s*['"]([^'"]*)['"]/gu;
  for (const match of objectMatch[1].matchAll(pairPattern)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined && key !== name) pairs.push([key, value]);
  }
  const declaredRole = pairs.find(([key]) => key === "busqueda")?.[1]?.toLowerCase();
  const role =
    declaredRole === "especializada"
      ? "specialized"
      : declaredRole === "general"
        ? "general"
        : undefined;
  return { pairs, role };
}

export function buildSearchPayload(html: string, options: SearchPayloadOptions): OrderedPairs {
  const $ = formFrom(html);
  const controls = extractSuccessfulControls(html);
  const mode = options.mode ?? "general";
  if (mode === "specialized") {
    replaceControl(controls, `${PJ_FORM_ID}:tabpanel-value`, "especializada");
  }
  replaceControl(controls, `${PJ_FORM_ID}:txtBusqueda`, options.query ?? "");
  replaceControl(controls, `${PJ_FORM_ID}:buCorte`, options.court === "supreme" ? "1" : "2");
  if (options.includeAutoQualifiers === true) {
    const autoControl = `${PJ_FORM_ID}:${mode === "specialized" ? "varAutos2" : "varAutos"}`;
    if ($(`[name="${autoControl}"]`).length !== 1) {
      throw new Error(`Estructura PJ inválida: control de autos ausente para ${mode}`);
    }
    const existing = controls.findIndex(([name]) => name === autoControl);
    if (existing < 0) controls.push([autoControl, "on"]);
    else controls[existing] = [autoControl, "on"];
  }
  controls.push(...extractSubmitParameters($, mode));
  return controls;
}

function appendAjaxBase(payload: OrderedPairs, source: string): void {
  payload.push(
    ["javax.faces.source", source],
    ["javax.faces.partial.event", "click"],
    ["javax.faces.partial.execute", `${source} @component`],
    ["javax.faces.partial.render", "@component"],
  );
}

export function pageAjaxControls(page: number): OrderedPairs {
  if (!Number.isInteger(page) || page < 1)
    throw new Error("La página PJ debe ser un entero positivo");
  const payload: OrderedPairs = [];
  const source = `${PJ_FORM_ID}:data1`;
  appendAjaxBase(payload, source);
  payload.push([`${source}:page`, String(page)]);
  appendAjaxTail(payload, source);
  return payload;
}

export function detailAjaxControls(descriptor: DetailRequestDescriptor): OrderedPairs {
  if (!descriptor.source.startsWith(`${PJ_FORM_ID}:repeat:`)) {
    throw new Error("Source de detalle PJ inválido");
  }
  const payload: OrderedPairs = [];
  appendAjaxBase(payload, descriptor.source);
  const parameterMap = new Map(descriptor.parameters);
  parameterMap.set("uuid", descriptor.nativeId);
  for (const name of DETAIL_PARAMETERS) payload.push([name, parameterMap.get(name) ?? ""]);
  payload.push(
    [descriptor.source, descriptor.source],
    ["org.richfaces.ajax.component", descriptor.source],
    ["AJAX:EVENTS_COUNT", "1"],
    ["javax.faces.partial.ajax", "true"],
  );
  return payload;
}

function appendAjaxTail(payload: OrderedPairs, source: string): void {
  payload.push(
    ["org.richfaces.ajax.component", source],
    [source, source],
    ["AJAX:EVENTS_COUNT", "1"],
    ["javax.faces.partial.ajax", "true"],
  );
}

export function buildPagePayload(html: string, page: number): OrderedPairs {
  const payload = extractSuccessfulControls(html);
  payload.push(...pageAjaxControls(page));
  return payload;
}

export function buildDetailPayload(
  html: string,
  descriptor: DetailRequestDescriptor,
): OrderedPairs {
  const payload = extractSuccessfulControls(html);
  payload.push(...detailAjaxControls(descriptor));
  return payload;
}

export function encodePayload(payload: OrderedPairs): string {
  const encoded = new URLSearchParams();
  for (const [name, value] of payload) encoded.append(name, value);
  return encoded.toString();
}

export function fingerprintPayload(payload: OrderedPairs): string {
  return createHash("sha256").update(encodePayload(payload)).digest("hex");
}
