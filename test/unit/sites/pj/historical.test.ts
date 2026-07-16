import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseJsfForm } from "../../../../src/core/jsf/form-parser.js";
import {
  historicalPageControls,
  historicalSearchPayload,
} from "../../../../src/sites/pj/historical-request-builders.js";
import { parseHistoricalResults } from "../../../../src/sites/pj/historical-parser.js";
import { PjHistoricalDiscoverySource } from "../../../../src/sites/pj/historical-discovery-source.js";

const fixture = async (name: string): Promise<string> =>
  await readFile(new URL(`../../../fixtures/pj/${name}`, import.meta.url), "utf8");

describe("colección histórica PJ", () => {
  it("deriva el submit semántico y conserva los filtros fijos", async () => {
    const html = await fixture("historical-search.html");
    const form = parseJsfForm(
      html,
      "https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resolucion-busqueda-especializada-superior.xhtml",
      "form#formBusqueda",
    );
    const payload = new Map(historicalSearchPayload(html, form.successfulControls));

    expect(payload.get("formBusqueda:cmbCorte")).toBe("2");
    expect(payload.get("formBusqueda:cmbInstancia")).toBe("2");
    expect(payload.get("formBusqueda:cmbInstanciaInput")).toBeDefined();
    expect(payload.get("formBusqueda:cmbEspecialidad")).toBe("2");
    expect(payload.get("formBusqueda:cmbEspecialidadInput")).toBeDefined();
    expect(payload.get("formBusqueda:dynamicSearch")).toBe("Buscar");
    expect(payload.get("forward")).toBe("buscar");
    expect(payload.get("busqueda")).toBe("especializada");
  });

  it("extrae solo UUID PDF, total y paginador dinámico", async () => {
    const parsed = parseHistoricalResults(await fixture("historical-results-page-1.html"));

    expect(parsed.queryTotal).toBe(6);
    expect(parsed.records).toHaveLength(5);
    expect(parsed.records.at(-1)?.nativeId).toBe("00000000-0000-4000-8000-000000000105");
    expect(parsed.scrollerSource).toBe("formBusqueda:dynamicScroller");
    expect(parsed.pagination).toMatchObject({ currentPage: 1, maxPages: 2, endSignal: "more" });
    expect(historicalPageControls(parsed.scrollerSource, 2)).toContainEqual([
      "formBusqueda:dynamicScroller:page",
      "2",
    ]);
  });

  it("reconoce el icono live de resolución aunque no esté rotulado PDF", async () => {
    const html = (await fixture("historical-results-page-1.html"))
      .replaceAll('data-file-type="pdf"', "")
      .replaceAll(">PDF<", '><img src="/assets/btn-ver-resolucion.png"><');
    const parsed = parseHistoricalResults(html);

    expect(parsed.records).toHaveLength(5);
  });

  it("acepta la respuesta parcial de la última página", async () => {
    const parsed = parseHistoricalResults(await fixture("historical-results-page-2.xml"), {
      currentPage: 2,
      queryTotal: 6,
    });

    expect(parsed.viewState).toBe("HIST-VS-2");
    expect(parsed.records.map(({ nativeId }) => nativeId)).toEqual([
      "00000000-0000-4000-8000-000000000106",
    ]);
    expect(parsed.pagination).toMatchObject({
      currentPage: 2,
      maxPages: 2,
      endSignal: "natural_end",
    });
  });

  it("construye un documento histórico válido con el contrato común de metadata", async () => {
    const parsed = parseHistoricalResults(await fixture("historical-results-page-1.html"));
    const adapter = {
      preflight: () => Promise.resolve(),
      bootstrap: () => Promise.resolve(),
      search: () => Promise.resolve(parsed),
      nextPage: () => Promise.resolve(parsed),
    };
    const source = new PjHistoricalDiscoverySource(
      adapter,
      () => new Date("2026-07-16T00:00:00.000Z"),
    );
    const record = parsed.records[0];
    if (record === undefined) throw new Error("fixture histórico vacío");

    await expect(
      source.enrichRecord(record, {
        partitionId: "historical-arbitration-lima",
        page: 1,
        row: 0,
      }),
    ).resolves.toMatchObject({
      documentId: record.nativeId,
      metadata: { list: record.metadata, detail: {}, unknownFields: {} },
      pdf: { state: "pending" },
    });
  });
});
