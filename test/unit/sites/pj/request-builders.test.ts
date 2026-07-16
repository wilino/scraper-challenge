import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  buildDetailPayload,
  buildPagePayload,
  buildSearchPayload,
  buildUniverseSearchPayload,
  encodePayload,
} from "../../../../src/sites/pj/request-builders.js";
import { parseResultsPage } from "../../../../src/sites/pj/parser.js";

const fixture = async (name: string): Promise<string> =>
  readFile(new URL(`../../../fixtures/pj/${name}`, import.meta.url), "utf8");
const requestFixture = async (name: string): Promise<string> =>
  (
    await readFile(new URL(`../../../fixtures/pj/requests/${name}`, import.meta.url), "utf8")
  ).trim();

describe("request builders PJ", () => {
  it("reproduce en orden el payload capturado de búsqueda", async () => {
    const payload = buildSearchPayload(await fixture("initial.html"), {
      court: "supreme",
      query: "derecho",
    });
    expect(encodePayload(payload)).toBe(await requestFixture("search-page-1.urlencoded"));
  });

  it("descubre parámetros Mojarra aunque RichFaces escape las comillas", () => {
    const html = `<form id="formBuscador" method="post">
      <input name="javax.faces.ViewState" value="STATE" />
      <input name="formBuscador:txtBusqueda" value="" />
      <input name="formBuscador:buCorte" value="1" />
      <input type="image" name="formBuscador:j_idt31"
        onclick="mojarra.jsfcljs(document.getElementById('formBuscador'),{\\'formBuscador:j_idt31\\':\\'formBuscador:j_idt31\\',\\'forward\\':\\'buscar\\'},\\'\\')" />
    </form>`;

    expect(buildSearchPayload(html, { court: "supreme" })).toEqual([
      ["javax.faces.ViewState", "STATE"],
      ["formBuscador:txtBusqueda", ""],
      ["formBuscador:buCorte", "1"],
      ["formBuscador:j_idt31", "formBuscador:j_idt31"],
      ["forward", "buscar"],
    ]);
  });

  it("construye la búsqueda Suprema avanzada con auto calificatorios observados", () => {
    const html = `<form id="formBuscador" method="post">
      <input name="javax.faces.ViewState" value="STATE" />
      <input name="formBuscador:tabpanel-value" value="general" />
      <input name="formBuscador:txtBusqueda" value="" />
      <input name="formBuscador:buCorte" value="1" />
      <input type="image" name="formBuscador:j_idt31"
        onclick="mojarra.jsfcljs(document.getElementById('formBuscador'),{'formBuscador:j_idt31':'formBuscador:j_idt31','forward':'buscar'},'')" />
      <input type="image" name="formBuscador:j_idt69"
        onclick="mojarra.jsfcljs(document.getElementById('formBuscador'),{\\'formBuscador:j_idt69\\':\\'formBuscador:j_idt69\\',\\'forward\\':\\'buscar\\',\\'formBuscador:j_idt71\\':\\'21\\'},\\'\\')" />
    </form>`;

    expect(
      buildSearchPayload(html, {
        court: "supreme",
        mode: "specialized",
        includeAutoQualifiers: true,
      }),
    ).toEqual([
      ["javax.faces.ViewState", "STATE"],
      ["formBuscador:tabpanel-value", "especializada"],
      ["formBuscador:txtBusqueda", ""],
      ["formBuscador:buCorte", "1"],
      ["formBuscador:varAutos2", "on"],
      ["formBuscador:j_idt69", "formBuscador:j_idt69"],
      ["forward", "buscar"],
      ["formBuscador:j_idt71", "21"],
    ]);
  });

  it("reproduce la página 2 con el ViewState de la respuesta anterior", async () => {
    const payload = buildPagePayload(await fixture("search-page-1.html"), 2);
    expect(encodePayload(payload)).toBe(await requestFixture("page-2.urlencoded"));
    expect(payload).toContainEqual(["javax.faces.ViewState", "FIXTURE_VIEWSTATE_1"]);
    expect(payload).toContainEqual(["formBuscador:data1:page", "2"]);
  });

  it("reproduce detalle RichFaces desde el descriptor real de la fila", async () => {
    const html = await fixture("search-page-2.html");
    const descriptor = parseResultsPage(html).records[0]?.detail;
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) return;
    expect(encodePayload(buildDetailPayload(html, descriptor))).toBe(
      await requestFixture("detail.urlencoded"),
    );
  });

  it("reproduce las particiones mecánicas Suprema y Superior conocidas", async () => {
    expect(encodePayload(buildUniverseSearchPayload("FIXTURE_VIEWSTATE_UNIVERSE", "supreme"))).toBe(
      await requestFixture("universe-supreme.urlencoded"),
    );
    expect(
      encodePayload(buildUniverseSearchPayload("FIXTURE_VIEWSTATE_UNIVERSE", "superior")),
    ).toBe(await requestFixture("universe-superior.urlencoded"));
  });
});
