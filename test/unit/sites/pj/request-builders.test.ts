import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  buildDetailPayload,
  buildPagePayload,
  buildSearchPayload,
  encodePayload,
  fingerprintPayload,
} from "../../../../src/sites/pj/request-builders.js";
import { parseResultsPage } from "../../../../src/sites/pj/parser.js";

const fixture = async (name: string): Promise<string> =>
  readFile(new URL(`../../../fixtures/pj/${name}`, import.meta.url), "utf8");
const requestFixture = async (name: string): Promise<string> =>
  (
    await readFile(new URL(`../../../fixtures/pj/requests/${name}`, import.meta.url), "utf8")
  ).trim();

describe("request builders PJ", () => {
  it("clasifica la variante viva por semántica aunque ambos submits contengan 21", async () => {
    const html = await fixture("live-search-submits.html");
    const specialized = buildSearchPayload(html, { court: "supreme", mode: "specialized" });
    const general = buildSearchPayload(html, { court: "superior", mode: "general" });

    expect(specialized).toContainEqual(["formBuscador:j_idt31", "formBuscador:j_idt31"]);
    expect(specialized).toContainEqual(["busqueda", "especializada"]);
    expect(general).toContainEqual(["formBuscador:j_idt69", "formBuscador:j_idt69"]);
    expect(general).toContainEqual(["formBuscador:j_idt71", "21"]);
  });

  it("falla cerrado ante declaraciones semánticas o fallbacks ambiguos", () => {
    const form = (submits: string) => `<form id="formBuscador">
      <input name="javax.faces.ViewState" value="STATE" />
      <input name="formBuscador:tabpanel-value" value="general" />
      <input name="formBuscador:txtBusqueda" value="" />
      <input name="formBuscador:buCorte" value="1" />${submits}</form>`;
    const submit = (name: string, extra: string) => `<input type="image" name="${name}"
      onclick="mojarra.jsfcljs(document.getElementById('formBuscador'),{'${name}':'${name}','forward':'buscar',${extra}},'')" />`;

    expect(() =>
      buildSearchPayload(
        form(
          submit("formBuscador:a", "'busqueda':'especializada'") +
            submit("formBuscador:b", "'busqueda':'especializada'"),
        ),
        { court: "supreme", mode: "specialized" },
      ),
    ).toThrow(/specialized ambiguo/);
    expect(() =>
      buildSearchPayload(
        form(
          submit("formBuscador:a", "'formBuscador:j_idt34':'21'") +
            submit("formBuscador:b", "'formBuscador:j_idt34':'21'"),
        ),
        { court: "supreme", mode: "specialized" },
      ),
    ).toThrow(/fallback specialized ambiguo/);
  });

  it("usa el fallback legado exacto solo cuando produce una asignación única", () => {
    const html = `<form id="formBuscador">
      <input name="javax.faces.ViewState" value="STATE" />
      <input name="formBuscador:tabpanel-value" value="general" />
      <input name="formBuscador:txtBusqueda" value="" />
      <input name="formBuscador:buCorte" value="1" />
      <input type="image" name="formBuscador:j_idt31"
        onclick="mojarra.jsfcljs(document.getElementById('formBuscador'),{'formBuscador:j_idt31':'formBuscador:j_idt31','forward':'buscar','formBuscador:j_idt34':'21'},'')" />
      <input type="image" name="formBuscador:j_idt69"
        onclick="mojarra.jsfcljs(document.getElementById('formBuscador'),{'formBuscador:j_idt69':'formBuscador:j_idt69','forward':'buscar','formBuscador:j_idt71':'21'},'')" />
    </form>`;

    expect(buildSearchPayload(html, { court: "supreme", mode: "specialized" })).toContainEqual([
      "formBuscador:j_idt31",
      "formBuscador:j_idt31",
    ]);
    expect(buildSearchPayload(html, { court: "superior", mode: "general" })).toContainEqual([
      "formBuscador:j_idt69",
      "formBuscador:j_idt69",
    ]);
  });

  it("rechaza usar el submit especializado capturado como si fuera general", async () => {
    const html = await fixture("initial.html");
    expect(() =>
      buildSearchPayload(html, {
        court: "supreme",
        query: "derecho",
        mode: "general",
      }),
    ).toThrow(/submit general no identificado por rol/);
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

  it("falla cerrado si falta autos o el submit especializado no tiene rol", () => {
    const base = `<form id="formBuscador" method="post">
      <input name="javax.faces.ViewState" value="STATE" />
      <input name="formBuscador:tabpanel-value" value="general" />
      <input name="formBuscador:txtBusqueda" value="" />
      <input name="formBuscador:buCorte" value="1" />
      <input type="image" name="formBuscador:j_idt31"
        onclick="mojarra.jsfcljs(document.getElementById('formBuscador'),{'formBuscador:j_idt31':'formBuscador:j_idt31','forward':'buscar'},'')" />
    </form>`;

    expect(() => buildSearchPayload(base, { court: "supreme", mode: "specialized" })).toThrow(
      /submit specialized no identificado por rol/,
    );
    expect(() =>
      buildSearchPayload(base, {
        court: "supreme",
        mode: "general",
        includeAutoQualifiers: true,
      }),
    ).toThrow(/control de autos ausente/);
  });

  it("construye la búsqueda Suprema avanzada con auto calificatorios observados", () => {
    const html = `<form id="formBuscador" method="post">
      <input name="javax.faces.ViewState" value="STATE" />
      <input name="formBuscador:tabpanel-value" value="general" />
      <input name="formBuscador:txtBusqueda" value="" />
      <input name="formBuscador:buCorte" value="1" />
      <input type="checkbox" name="formBuscador:varAutos2" />
      <input type="image" name="formBuscador:j_idt31"
        onclick="mojarra.jsfcljs(document.getElementById('formBuscador'),{'formBuscador:j_idt31':'formBuscador:j_idt31','forward':'buscar'},'')" />
      <input type="image" name="formBuscador:j_idt69"
        onclick="mojarra.jsfcljs(document.getElementById('formBuscador'),{\\'formBuscador:j_idt69\\':\\'formBuscador:j_idt69\\',\\'forward\\':\\'buscar\\',\\'busqueda\\':\\'especializada\\',\\'formBuscador:j_idt71\\':\\'21\\'},\\'\\')" />
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
      ["busqueda", "especializada"],
      ["formBuscador:j_idt71", "21"],
    ]);
    expect(
      fingerprintPayload(
        buildSearchPayload(html, {
          court: "supreme",
          mode: "specialized",
          includeAutoQualifiers: true,
        }),
      ),
    ).toBe("841ef6e0825a8bce6f732e01badb23326103e1b19bade7f712b4c087685e5566");
  });

  it("descubre roles de submit aunque el DOM invierta su orden", () => {
    const html = `<form id="formBuscador" method="post">
      <input name="javax.faces.ViewState" value="STATE" />
      <input name="formBuscador:tabpanel-value" value="general" />
      <input name="formBuscador:txtBusqueda" value="" />
      <input name="formBuscador:buCorte" value="1" />
      <input type="image" name="formBuscador:j_idt69"
        onclick="mojarra.jsfcljs(document.getElementById('formBuscador'),{'formBuscador:j_idt69':'formBuscador:j_idt69','forward':'buscar','busqueda':'especializada','formBuscador:j_idt71':'21'},'')" />
      <input type="image" name="formBuscador:j_idt31"
        onclick="mojarra.jsfcljs(document.getElementById('formBuscador'),{'formBuscador:j_idt31':'formBuscador:j_idt31','forward':'buscar','busqueda':'general'},'')" />
    </form>`;

    expect(buildSearchPayload(html, { court: "superior", mode: "general" })).toContainEqual([
      "formBuscador:j_idt31",
      "formBuscador:j_idt31",
    ]);
    expect(buildSearchPayload(html, { court: "supreme", mode: "specialized" })).toContainEqual([
      "formBuscador:j_idt69",
      "formBuscador:j_idt69",
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
    const ajax = buildDetailPayload(html, descriptor);
    expect(ajax).toContainEqual(["uuid", descriptor.nativeId]);
    expect(ajax.some(([name]) => name === "sumilla" || name === "palabras")).toBe(false);
  });
});
