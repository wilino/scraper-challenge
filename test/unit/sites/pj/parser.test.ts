import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  PjStructuralError,
  mergeListAndDetail,
  parseDetail,
  parsePartialResponse,
  parseResultsPage,
} from "../../../../src/sites/pj/parser.js";

const fixture = async (name: string): Promise<string> =>
  readFile(new URL(`../../../fixtures/pj/${name}`, import.meta.url), "utf8");

describe("parser offline PJ", () => {
  it("falla cerrado ante resultados incompletos o un ViewState reutilizado", async () => {
    const empty = `<form id="formBuscador">
      <input name="javax.faces.ViewState" value="SAME_STATE" />
      <span id="formBuscador:data1"></span>
      <div id="formBuscador:panel"></div>
    </form>`;
    expect(() => parseResultsPage(empty)).toThrow(/total de resultados ausente/);
    expect(() =>
      parseResultsPage(
        empty.replace(
          '<span id="formBuscador:data1">',
          '<span id="formBuscador:optResultado">De un total de 1 resoluciones, se obtuvieron 1 resultados.</span><span id="formBuscador:data1">',
        ),
      ),
    ).toThrow(/página con resultados pero sin filas/);

    const page = await fixture("search-page-1.html");
    expect(() =>
      parseResultsPage(page, {
        previousViewState: "FIXTURE_VIEWSTATE_1",
        requireChangedViewState: true,
      }),
    ).toThrow(/reutilizó el ViewState anterior/);
  });

  it("promueve redirects y errores parciales a fallos estructurales", async () => {
    const redirect = await fixture("partial-redirect.xml");
    const error = await fixture("partial-error.xml");
    expect(() => parseResultsPage(redirect)).toThrow(/requiere rebootstrap/);
    expect(() => parseResultsPage(error)).toThrow(/Error parcial PJ/);
  });

  it("extrae página 1 y página 2 con IDs, totales y fingerprints distintos", async () => {
    const page1 = parseResultsPage(await fixture("search-page-1.html"));
    const page2 = parseResultsPage(await fixture("search-page-2.html"), {
      previousViewState: page1.viewState,
      requireChangedViewState: true,
    });

    expect(page1).toMatchObject({
      viewState: "FIXTURE_VIEWSTATE_1",
      queryTotal: 151191,
      publishedGlobalTotal: 670050,
      pagination: { currentPage: 1, maxPages: 15120, endSignal: "more" },
    });
    expect(page1.records).toHaveLength(10);
    expect(page1.records[0]).toMatchObject({
      nativeId: "00000000-0000-4000-8000-000000000001",
      recordIndex: 0,
      row: 0,
      normalized: { caseNumber: "PJ-FIX-0001", resolutionDate: "15/01/2024" },
      detail: { source: "formBuscador:repeat:0:j_idt491" },
    });
    expect(page2.records.map(({ recordIndex }) => recordIndex)).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
    expect(page2.fingerprint).not.toBe(page1.fingerprint);
  });

  it("procesa primero los updates parciales y reemplaza ViewState", async () => {
    const page = parseResultsPage(await fixture("partial-page-2.xml"), {
      queryTotal: 151191,
      publishedGlobalTotal: 670050,
      previousViewState: "FIXTURE_VIEWSTATE_1",
      requireChangedViewState: true,
    });
    expect(page.viewState).toBe("FIXTURE_VIEWSTATE_2");
    expect(page.pagination.currentPage).toBe(2);
    expect(page.records[0]?.normalized.caseNumber).toBe("PJ-FIX-0011");
  });

  it("acepta XHTML completo con declaración XML sin confundirlo con partial-response", async () => {
    const html = await fixture("search-page-1.html");
    const page = parseResultsPage(`<?xml version="1.0" encoding="UTF-8"?>\n${html}`);

    expect(page.pagination.currentPage).toBe(1);
    expect(page.records).toHaveLength(10);
  });

  it("solo reconoce fin natural con última página, sin next/last y con filas", async () => {
    const page = parseResultsPage(await fixture("search-last-page-contract.html"), {
      queryTotal: 151191,
      publishedGlobalTotal: 670050,
    });
    expect(page.pagination).toMatchObject({
      currentPage: 15120,
      maxPages: 15120,
      hasNext: false,
      hasLast: false,
      endSignal: "natural_end",
    });
    expect(page.records[0]?.recordIndex).toBe(151190);
  });

  it("extrae lista Superior y conserva su source dinámico alternativo", async () => {
    const page = parseResultsPage(await fixture("search-superior-page-1.html"));
    expect(page.queryTotal).toBe(88291);
    expect(page.pagination).toMatchObject({ currentPage: 1, maxPages: 8830, endSignal: "more" });
    expect(page.records).toHaveLength(2);
    expect(page.records[0]?.detail.source).toBe("formBuscador:repeat:0:j_idt503");
  });

  it("extrae la estructura RichFaces live sin atributos data-field/data-uuid", () => {
    const id = "00000000-0000-4000-8000-000000000099";
    const html = `<form id="formBuscador">
      <input name="javax.faces.ViewState" value="LIVE_STATE" />
      <span id="formBuscador:optResultado">De un total de 1 resoluciones, se obtuvieron 1 resultados.</span>
      <div id="formBuscador:panel">
        <div id="formBuscador:repeat:0:j_idt455">
          <div id="formBuscador:repeat:0:j_idt455_header"><span>Casación</span><span>EXP-099</span></div>
          <div id="formBuscador:repeat:0:j_idt455_body">
            <div class="col-sm-4 marginb"><div class="col-md-12 txtbold">Tipo Resolución:</div><div class="col-md-12">Ejecutoria Suprema</div></div>
            <div class="col-sm-4 marginb"><div class="col-md-12 txtbold">Fecha Resolución:</div><div class="col-md-12">16/07/2026</div></div>
            <a id="formBuscador:repeat:0:j_idt491" title="Ver" onclick='RichFaces.ajax(\\"source\\",event,{\\"parameters\\":{\\"uuid\\":\\"${id.replaceAll("-", "\\u002D")}\\"}})'></a>
          </div>
        </div>
      </div>
      <span id="formBuscador:data1"></span>
    </form>`;

    const page = parseResultsPage(html);
    expect(page.records[0]).toMatchObject({
      nativeId: id,
      metadata: {
        recurso: ["Casación"],
        nroexp: ["EXP-099"],
        tipoResolucion: ["Ejecutoria Suprema"],
        fechaResolucion: ["16/07/2026"],
      },
    });
  });

  it("parsea y fusiona el detalle Suprema, incluido PDF estable y Word separado", async () => {
    const page = parseResultsPage(await fixture("search-page-2.html"));
    const htmlDetail = parseDetail(await fixture("detail.html"), "supreme");
    const partialDetail = parseDetail(await fixture("detail-partial.xml"), "supreme");
    const record = page.records[0];
    expect(record).toBeDefined();
    if (record === undefined) return;

    expect(partialDetail).toMatchObject({
      popupId: "formBuscador:popupResolucion",
      viewState: "FIXTURE_VIEWSTATE_3",
      unknownFields: {},
      normalized: {
        resolutionDate: ["30/01/2024"],
        judges: ["***"],
        superiorCaseNumber: ["PJ-FIX-SUP-0011"],
      },
    });
    expect(partialDetail.pdf).toEqual(htmlDetail.pdf);
    expect(partialDetail.pdf).toEqual({
      method: "GET",
      url: "https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/ServletDescarga?uuid=00000000-0000-4000-8000-000000009011",
    });
    expect(partialDetail.wordUrl).toContain("00000000-0000-4000-8000-000000009021");

    const merged = mergeListAndDetail(record, partialDetail);
    expect(merged.metadata.list.nroexp).toEqual(["PJ-FIX-0011"]);
    expect(merged.metadata.detail["N° de Expediente de la Sala Superior"]).toEqual([
      "PJ-FIX-SUP-0011",
    ]);
    expect(merged.pdf).toEqual(partialDetail.pdf);
  });

  it("aplica popup y aliases de labels de Corte Superior", async () => {
    const detail = parseDetail(await fixture("detail-superior-partial.xml"), "superior");
    expect(detail).toMatchObject({
      popupId: "formBuscador:popupResolucionSuperior",
      viewState: "FIXTURE_VIEWSTATE_SUPERIOR_2",
      unknownFields: {},
      normalized: {
        judges: ["***"],
        chamber: ["Sala Superior Ficticia A"],
        district: ["Distrito Superior Ficticio"],
        processType: ["Proceso superior ficticio"],
        claimOrOffense: ["Materia superior ficticia A"],
      },
    });
    expect(detail.pdf?.url).toContain("00000000-0000-4000-8000-000000009101");
  });

  it("parsea el popup live basado en grid y reconoce iconos PDF/Word", () => {
    const pdfId = "00000000-0000-4000-8000-000000009201";
    const wordId = "00000000-0000-4000-8000-000000009202";
    const html = `<div id="formBuscador:popupResolucion">
      <div class="panel-body"><div class="row marginb">
        <div class="col-sm-6 txtbold">Fecha de la Resolución:</div>
        <div class="col-sm-6 marginb2"><span class="data">16/07/2026</span></div>
        <div class="col-sm-6 txtbold">*** Ponente:</div>
        <div class="col-sm-6 marginb2"><span class="data">***</span></div>
      </div></div>
      <a href="/jurisprudenciaweb/ServletDescarga?uuid=${pdfId}"><img src="/images/iconpdf.png" /></a>
      <a href="/jurisprudenciaweb/ServletDescarga?uuid=${wordId}"><input src="/images/iconword.png" /></a>
    </div>`;

    const detail = parseDetail(html, "supreme");
    expect(detail.normalized).toEqual({ resolutionDate: ["16/07/2026"], reportingJudge: ["***"] });
    expect(detail.pdf?.url).toContain(pdfId);
    expect(detail.wordUrl).toContain(wordId);
  });

  it("preserva labels nuevos como unknownFields y emite alerta", async () => {
    const html = (await fixture("detail.html")).replace(
      "<dt>Fecha de la Resolución:</dt>",
      "<dt>Campo PJ Nuevo:</dt><dd>valor nuevo</dd><dt>Fecha de la Resolución:</dt>",
    );
    const detail = parseDetail(html, "supreme");
    expect(detail.unknownFields).toEqual({ "Campo PJ Nuevo": ["valor nuevo"] });
    expect(detail.warnings).toEqual(["Etiqueta de detalle PJ no inventariada: Campo PJ Nuevo"]);
  });

  it("diferencia redirect, error y pérdida del panel esperado", async () => {
    expect(parsePartialResponse(await fixture("partial-redirect.xml"))).toEqual({
      kind: "redirect",
      url: "/jurisprudenciaweb/faces/page/inicio.xhtml",
    });
    expect(parsePartialResponse(await fixture("partial-error.xml"))).toMatchObject({
      kind: "error",
      name: "javax.faces.application.ViewExpiredException",
    });
    const superiorDetail = await fixture("detail-superior-partial.xml");
    expect(() => parseDetail(superiorDetail, "supreme")).toThrow(PjStructuralError);
  });

  it("rechaza un descriptor PDF fuera del origen permitido", async () => {
    const html = (await fixture("detail.html")).replace(
      "/jurisprudenciaweb/ServletDescarga?uuid=00000000-0000-4000-8000-000000009011",
      "https://example.com/jurisprudenciaweb/ServletDescarga?uuid=00000000-0000-4000-8000-000000009011",
    );
    expect(() => parseDetail(html, "supreme")).toThrow(PjStructuralError);
  });
});
