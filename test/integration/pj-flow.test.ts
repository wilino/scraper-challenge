import { readFile } from "node:fs/promises";

import { load } from "cheerio";
import { describe, expect, it, vi } from "vitest";

import type { ScraperConfig } from "../../src/config/env.js";
import type {
  ControlledRequest,
  ControlledResponse,
  StatefulRequest,
} from "../../src/core/http-client.js";
import { HttpRequestError } from "../../src/core/http-errors.js";
import { createLogger } from "../../src/core/logger.js";
import { PjAdapter, type PjHttpTransport } from "../../src/sites/pj/adapter.js";
import { PjDiscoverySource } from "../../src/sites/pj/discovery-source.js";

const fixture = async (name: string): Promise<string> =>
  readFile(new URL(`../fixtures/pj/${name}`, import.meta.url), "utf8");

const requestFixture = async (name: string): Promise<string> =>
  (await fixture(`requests/${name}`)).trim();

const config: ScraperConfig = {
  baseUrl: "https://jurisprudencia.pj.gob.pe",
  startPath: "/jurisprudenciaweb/faces/page/inicio.xhtml",
  resultsPath: "/jurisprudenciaweb/faces/page/resultado.xhtml",
  outputDir: "/tmp/pj-adapter-test",
  connectTimeoutMs: 100,
  requestTimeoutMs: 100,
  pdfTimeoutMs: 100,
  minRequestDelayMs: 1,
  maxRequestDelayMs: 1,
  maxRetries: 1,
  backoffBaseMs: 1,
  backoffMaxMs: 1,
  globalCooldownAfter429Ms: 1,
  maxPdfBytes: 1024,
  maxHtmlBytes: 1024 * 1024,
  htmlConcurrency: 1,
  pdfConcurrency: 1,
  userAgent: "test",
  logLevel: "silent",
};

function response(
  data: string,
  contentType = "text/html;charset=UTF-8",
): ControlledResponse<string> {
  return {
    status: 200,
    headers: { "content-type": contentType },
    data,
    url: `${config.baseUrl}${config.resultsPath}`,
    attempts: 1,
  };
}

function exhaustedDetail500(label: string): HttpRequestError {
  return new HttpRequestError(label, {
    classification: "http_transient",
    retryable: true,
    safePath: config.resultsPath,
    status: 500,
    attempt: config.maxRetries + 1,
  });
}

function repeatedPreviousPage(initial: string): string {
  const $ = load(initial);
  const panel = $("[id='formBuscador:panel']").prop("outerHTML");
  if (panel === null) throw new Error("Fixture inicial sin panel de resultados");
  return `<?xml version="1.0" encoding="UTF-8"?>
<partial-response><changes>
  <update id="formBuscador:data1"><![CDATA[<span id="formBuscador:data1" data-current-page="2" data-max-value="15120"><span class="rf-ds-act">2</span></span>]]></update>
  <update id="formBuscador:panel"><![CDATA[${panel}]]></update>
  <update id="javax.faces.ViewState"><![CDATA[SILENT_REPEAT_VIEWSTATE]]></update>
</changes></partial-response>`;
}

function distinctRecordsAtWrongPage(page2: string, viewState = "WRONG_PAGE_VIEWSTATE"): string {
  return page2
    .replace('data-current-page="2"', 'data-current-page="1"')
    .replace("FIXTURE_VIEWSTATE_2", viewState);
}

function retargetPartial(page2: string, page: number, marker: string): string {
  return page2
    .replaceAll('data-current-page="2"', `data-current-page="${String(page)}"`)
    .replaceAll('class="rf-ds-act">2<', `class="rf-ds-act">${String(page)}<`)
    .replaceAll('"currentPage":2', `"currentPage":${String(page)}`)
    .replaceAll("FIXTURE_VIEWSTATE_2", `FIXTURE_VIEWSTATE_${String(page)}`)
    .replace("Segunda página anonimizada", marker);
}

class QueueTransport implements PjHttpTransport {
  readonly requests: ControlledRequest[] = [];
  readonly preflight = vi.fn(async () => {
    await Promise.resolve();
  });

  constructor(
    private readonly responses: (ControlledResponse<string> | Error)[],
    private readonly recoverFirstStateful = false,
  ) {}

  request(request: ControlledRequest): Promise<ControlledResponse<string>> {
    this.requests.push(request);
    return Promise.resolve(this.take());
  }

  async requestStateful(request: StatefulRequest<string>): Promise<ControlledResponse<string>> {
    this.requests.push(request.buildRequest(1));
    if (this.recoverFirstStateful) {
      await request.restorePage(
        new HttpRequestError("vista expirada de prueba", {
          classification: "transient",
          retryable: true,
          requiresRebootstrap: true,
          safePath: config.resultsPath,
          attempt: 1,
        }),
      );
      this.requests.push(request.buildRequest(2));
      return this.take();
    }
    const first = this.responses.shift();
    if (
      first instanceof HttpRequestError &&
      first.classification === "http_transient" &&
      first.status === 500
    ) {
      await request.restorePage(first);
      this.requests.push(request.buildRequest(2));
      try {
        return this.take();
      } catch (error: unknown) {
        if (!(error instanceof HttpRequestError)) throw error;
        await request.restorePage(error);
        throw error;
      }
    }
    if (first === undefined) throw new Error("Respuesta de prueba no configurada");
    if (first instanceof Error) throw first;
    return first;
  }

  private take(): ControlledResponse<string> {
    const next = this.responses.shift();
    if (next === undefined) throw new Error("Respuesta de prueba no configurada");
    if (next instanceof Error) throw next;
    return next;
  }
}

describe("flujo HTTP stateful del adaptador PJ", () => {
  it("reanuda en la página 12 mediante un solo salto directo", async () => {
    const [initial, page1, page2] = await Promise.all([
      fixture("initial.html"),
      fixture("search-page-1.html"),
      fixture("partial-page-2.xml"),
    ]);
    const corpusInitial = initial.replace(
      "</form>",
      '<input type="checkbox" name="formBuscador:varAutos2" /></form>',
    );
    const http = new QueueTransport([
      response(corpusInitial),
      response(page1),
      response(retargetPartial(page2, 12, "salto directo 12"), "text/xml;charset=UTF-8"),
    ]);
    const adapter = new PjAdapter(config, {
      http,
      logger: createLogger({ runId: "direct-resume-test", level: "silent" }),
    });
    const source = new PjDiscoverySource(adapter);

    const resumed = await source.openPartition("supreme", 12);

    expect(resumed.parsed.pagination.currentPage).toBe(12);
    expect(http.requests.map(({ page }) => page)).toEqual([undefined, 1, 12]);
    const pageRequests = http.requests.filter(
      ({ phase, page }) => phase === "discover" && page === 12,
    );
    expect(pageRequests).toHaveLength(1);
    expect(String(pageRequests[0]?.body)).toContain("formBuscador%3Adata1%3Apage=12");
  });

  it("hace bootstrap, búsqueda, página 2 y detalle con el estado inmediatamente anterior", async () => {
    const [initial, page1, page2, detail] = await Promise.all([
      fixture("initial.html"),
      fixture("search-page-1.html"),
      fixture("partial-page-2.xml"),
      fixture("detail-partial.xml"),
    ]);
    const http = new QueueTransport([
      response(initial),
      response(page1),
      response(page2, "text/xml;charset=UTF-8"),
      response(detail, "text/xml;charset=UTF-8"),
    ]);
    const logger = createLogger({ runId: "adapter-test", level: "silent" });
    const adapter = new PjAdapter(config, { http, logger });

    await adapter.preflight();
    const first = await adapter.search({ court: "supreme", query: "derecho", mode: "specialized" });
    const second = await adapter.nextPage();
    const record = second.records[0];
    expect(record).toBeDefined();
    if (record === undefined) throw new Error("Fixture sin registro en página 2");
    const complete = await adapter.fetchDetail(record);

    expect(http.preflight).toHaveBeenCalledWith(config.startPath);
    expect(first.pagination.currentPage).toBe(1);
    expect(second.pagination.currentPage).toBe(2);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(complete.merged.pdf?.url).toContain("ServletDescarga?uuid=");
    expect(http.requests.map((request) => request.body).filter(Boolean)).toEqual([
      (await requestFixture("search-page-1.urlencoded")).replace(
        "formBuscador%3Atabpanel-value=general",
        "formBuscador%3Atabpanel-value=especializada",
      ),
      await requestFixture("page-2.urlencoded"),
      await requestFixture("detail.urlencoded"),
    ]);
  });

  it("reconstruye directamente la página actual y reintenta una sola vez un detalle con 500 agotado", async () => {
    const [initial, page1, page2, detail] = await Promise.all([
      fixture("initial.html"),
      fixture("search-page-1.html"),
      fixture("partial-page-2.xml"),
      fixture("detail-partial.xml"),
    ]);
    const recoveredPage1 = page1.replaceAll("FIXTURE_VIEWSTATE_1", "RECOVERED_VIEWSTATE_1");
    const recoveredPage2 = page2.replaceAll("FIXTURE_VIEWSTATE_2", "RECOVERED_VIEWSTATE_2");
    const firstError = exhaustedDetail500("500 agotado antes de recuperar");
    const http = new QueueTransport([
      response(initial),
      response(page1),
      response(page2, "text/xml;charset=UTF-8"),
      firstError,
      response(initial),
      response(recoveredPage1),
      response(recoveredPage2, "text/xml;charset=UTF-8"),
      response(detail, "text/xml;charset=UTF-8"),
    ]);
    const adapter = new PjAdapter(config, {
      http,
      logger: createLogger({ runId: "detail-500-recovery-test", level: "silent" }),
    });

    await adapter.search({ court: "supreme", query: "derecho", mode: "specialized" });
    const second = await adapter.nextPage();
    const record = second.records[0];
    if (record === undefined) throw new Error("Fixture sin registro en página 2");

    const complete = await adapter.fetchDetail(record);

    expect(complete.list.nativeId).toBe(record.nativeId);
    expect(adapter.currentResults.pagination.currentPage).toBe(2);
    expect(http.requests.map(({ phase, page }) => `${phase}:${String(page)}`)).toEqual([
      "discover:undefined",
      "discover:1",
      "discover:2",
      "detail:2",
      "discover:undefined",
      "discover:1",
      "discover:2",
      "detail:2",
    ]);
  });

  it("tras el intento posterior limpia la sesión antes de continuar con la siguiente fila", async () => {
    const [initial, page1, page2, detail] = await Promise.all([
      fixture("initial.html"),
      fixture("search-page-1.html"),
      fixture("partial-page-2.xml"),
      fixture("detail-partial.xml"),
    ]);
    const recoveredPage1 = page1.replaceAll("FIXTURE_VIEWSTATE_1", "RECOVERED_VIEWSTATE_1");
    const recoveredPage2 = page2.replaceAll("FIXTURE_VIEWSTATE_2", "RECOVERED_VIEWSTATE_2");
    const cleanPage1 = page1.replaceAll("FIXTURE_VIEWSTATE_1", "CLEAN_VIEWSTATE_1");
    const cleanPage2 = page2.replaceAll("FIXTURE_VIEWSTATE_2", "CLEAN_VIEWSTATE_2");
    const firstError = exhaustedDetail500("primer 500 agotado");
    const secondError = exhaustedDetail500("segundo 500 agotado");
    const http = new QueueTransport([
      response(initial),
      response(page1),
      response(page2, "text/xml;charset=UTF-8"),
      firstError,
      response(initial),
      response(recoveredPage1),
      response(recoveredPage2, "text/xml;charset=UTF-8"),
      secondError,
      response(initial),
      response(cleanPage1),
      response(cleanPage2, "text/xml;charset=UTF-8"),
      response(detail, "text/xml;charset=UTF-8"),
    ]);
    const adapter = new PjAdapter(config, {
      http,
      logger: createLogger({ runId: "bounded-detail-500-recovery-test", level: "silent" }),
    });

    await adapter.search({ court: "supreme", query: "derecho", mode: "specialized" });
    const second = await adapter.nextPage();
    const failedRecord = second.records[0];
    const nextRecord = second.records[1];
    if (failedRecord === undefined || nextRecord === undefined)
      throw new Error("Fixture sin registros suficientes en página 2");

    await expect(adapter.fetchDetail(failedRecord)).rejects.toBe(secondError);
    expect(adapter.currentResults.pagination.currentPage).toBe(2);
    await expect(adapter.fetchDetail(nextRecord)).resolves.toMatchObject({
      list: { nativeId: nextRecord.nativeId },
    });

    expect(http.requests.filter(({ phase }) => phase === "detail")).toHaveLength(3);
    expect(
      http.requests.filter(({ phase, page }) => phase === "discover" && page === 2),
    ).toHaveLength(3);
    expect(http.requests).toHaveLength(12);
  });

  it("limpia también la sesión tras un fallo no recuperable posterior al restore", async () => {
    const [initial, page1, page2] = await Promise.all([
      fixture("initial.html"),
      fixture("search-page-1.html"),
      fixture("partial-page-2.xml"),
    ]);
    const recoveredPage1 = page1.replaceAll("FIXTURE_VIEWSTATE_1", "RECOVERED_VIEWSTATE_1");
    const recoveredPage2 = page2.replaceAll("FIXTURE_VIEWSTATE_2", "RECOVERED_VIEWSTATE_2");
    const cleanPage1 = page1.replaceAll("FIXTURE_VIEWSTATE_1", "CLEAN_VIEWSTATE_1");
    const cleanPage2 = page2.replaceAll("FIXTURE_VIEWSTATE_2", "CLEAN_VIEWSTATE_2");
    const structuralError = new HttpRequestError("panel de detalle ausente", {
      classification: "structural",
      retryable: false,
      safePath: config.resultsPath,
      attempt: 1,
    });
    const http = new QueueTransport([
      response(initial),
      response(page1),
      response(page2, "text/xml;charset=UTF-8"),
      exhaustedDetail500("500 agotado antes del error estructural"),
      response(initial),
      response(recoveredPage1),
      response(recoveredPage2, "text/xml;charset=UTF-8"),
      structuralError,
      response(initial),
      response(cleanPage1),
      response(cleanPage2, "text/xml;charset=UTF-8"),
    ]);
    const adapter = new PjAdapter(config, {
      http,
      logger: createLogger({ runId: "non-recoverable-detail-test", level: "silent" }),
    });

    await adapter.search({ court: "supreme", query: "derecho", mode: "specialized" });
    const second = await adapter.nextPage();
    const record = second.records[0];
    if (record === undefined) throw new Error("Fixture sin registro en página 2");

    await expect(adapter.fetchDetail(record)).rejects.toBe(structuralError);
    expect(http.requests).toHaveLength(11);
    expect(http.requests.filter(({ phase }) => phase === "detail")).toHaveLength(2);
  });

  it("detiene la fila sin ocultar un fallo al restaurar la sesión de detalle", async () => {
    const [initial, page1, page2] = await Promise.all([
      fixture("initial.html"),
      fixture("search-page-1.html"),
      fixture("partial-page-2.xml"),
    ]);
    const recoveryFailure = new HttpRequestError("búsqueda de recuperación agotada", {
      classification: "http_transient",
      retryable: true,
      safePath: config.resultsPath,
      status: 500,
      attempt: config.maxRetries + 1,
    });
    const http = new QueueTransport([
      response(initial),
      response(page1),
      response(page2, "text/xml;charset=UTF-8"),
      exhaustedDetail500("detalle agotado"),
      response(initial),
      recoveryFailure,
    ]);
    const adapter = new PjAdapter(config, {
      http,
      logger: createLogger({ runId: "fatal-detail-recovery-test", level: "silent" }),
    });

    await adapter.search({ court: "supreme", query: "derecho", mode: "specialized" });
    const second = await adapter.nextPage();
    const record = second.records[0];
    if (record === undefined) throw new Error("Fixture sin registro en página 2");

    await expect(adapter.fetchDetail(record)).rejects.toMatchObject({
      name: "PjAdapterStateError",
      message: "No se pudo restaurar la sesión PJ en la página 2",
      cause: recoveryFailure,
    });
    expect(http.requests.filter(({ phase }) => phase === "detail")).toHaveLength(1);
  });

  it("promueve a fatal un fallo del cleanup posterior", async () => {
    const [initial, page1, page2] = await Promise.all([
      fixture("initial.html"),
      fixture("search-page-1.html"),
      fixture("partial-page-2.xml"),
    ]);
    const recoveredPage1 = page1.replaceAll("FIXTURE_VIEWSTATE_1", "RECOVERED_VIEWSTATE_1");
    const recoveredPage2 = page2.replaceAll("FIXTURE_VIEWSTATE_2", "RECOVERED_VIEWSTATE_2");
    const cleanupFailure = new HttpRequestError("cleanup de búsqueda agotado", {
      classification: "http_transient",
      retryable: true,
      safePath: config.resultsPath,
      status: 500,
      attempt: config.maxRetries + 1,
    });
    const http = new QueueTransport([
      response(initial),
      response(page1),
      response(page2, "text/xml;charset=UTF-8"),
      exhaustedDetail500("primer 500 agotado"),
      response(initial),
      response(recoveredPage1),
      response(recoveredPage2, "text/xml;charset=UTF-8"),
      exhaustedDetail500("500 posterior al restore"),
      response(initial),
      cleanupFailure,
    ]);
    const adapter = new PjAdapter(config, {
      http,
      logger: createLogger({ runId: "fatal-second-detail-cleanup-test", level: "silent" }),
    });

    await adapter.search({ court: "supreme", query: "derecho", mode: "specialized" });
    const second = await adapter.nextPage();
    const record = second.records[0];
    if (record === undefined) throw new Error("Fixture sin registro en página 2");

    await expect(adapter.fetchDetail(record)).rejects.toMatchObject({
      name: "PjAdapterStateError",
      message: "No se pudo restaurar la sesión PJ en la página 2",
      cause: cleanupFailure,
    });
    expect(http.requests.filter(({ phase }) => phase === "detail")).toHaveLength(2);
  });

  it("descarta el ViewState inválido, repite la búsqueda y se reposiciona una sola vez", async () => {
    const [initial, page1, page2] = await Promise.all([
      fixture("initial.html"),
      fixture("search-page-1.html"),
      fixture("partial-page-2.xml"),
    ]);
    const recoveredPage1 = page1.replaceAll("FIXTURE_VIEWSTATE_1", "RECOVERED_VIEWSTATE_1");
    const http = new QueueTransport(
      [
        response(initial),
        response(page1),
        response(initial),
        response(recoveredPage1),
        response(page2, "text/xml;charset=UTF-8"),
      ],
      true,
    );
    const adapter = new PjAdapter(config, {
      http,
      logger: createLogger({ runId: "recovery-test", level: "silent" }),
    });

    await adapter.search({ court: "supreme", query: "derecho", mode: "specialized" });
    const recovered = await adapter.nextPage();
    const pageRequests = http.requests.filter((request) => request.page === 2);

    expect(recovered.pagination.currentPage).toBe(2);
    expect(pageRequests).toHaveLength(2);
    expect(String(pageRequests[0]?.body)).toContain("FIXTURE_VIEWSTATE_1");
    expect(String(pageRequests[1]?.body)).toContain("RECOVERED_VIEWSTATE_1");
  });

  it("rebootstrappea una repetición silenciosa y reintenta la página objetivo una sola vez", async () => {
    const [initial, page1, page2] = await Promise.all([
      fixture("initial.html"),
      fixture("search-page-1.html"),
      fixture("partial-page-2.xml"),
    ]);
    const recoveredPage1 = page1.replaceAll("FIXTURE_VIEWSTATE_1", "RECOVERED_VIEWSTATE_1");
    const http = new QueueTransport([
      response(initial),
      response(page1),
      response(repeatedPreviousPage(page1), "text/xml;charset=UTF-8"),
      response(initial),
      response(recoveredPage1),
      response(page2, "text/xml;charset=UTF-8"),
    ]);
    const adapter = new PjAdapter(config, {
      http,
      logger: createLogger({ runId: "silent-repeat-test", level: "silent" }),
    });

    const first = await adapter.search({ court: "supreme", query: "derecho", mode: "specialized" });
    const recovered = await adapter.nextPage();
    const pageRequests = http.requests.filter((request) => request.page === 2);

    expect(first.records.map(({ nativeId }) => nativeId)).toHaveLength(10);
    expect(recovered.pagination.currentPage).toBe(2);
    expect(recovered.records.map(({ nativeId }) => nativeId)).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `00000000-0000-4000-8000-${String(index + 11).padStart(12, "0")}`,
      ),
    );
    expect(pageRequests).toHaveLength(2);
    expect(String(pageRequests[0]?.body)).toContain("FIXTURE_VIEWSTATE_1");
    expect(String(pageRequests[1]?.body)).toContain("RECOVERED_VIEWSTATE_1");
  });

  it("abandona tras una segunda repetición silenciosa para evitar un bucle", async () => {
    const [initial, page1] = await Promise.all([
      fixture("initial.html"),
      fixture("search-page-1.html"),
    ]);
    const recoveredPage1 = page1.replaceAll("FIXTURE_VIEWSTATE_1", "RECOVERED_VIEWSTATE_1");
    const repeated = repeatedPreviousPage(page1);
    const http = new QueueTransport([
      response(initial),
      response(page1),
      response(repeated, "text/xml;charset=UTF-8"),
      response(initial),
      response(recoveredPage1),
      response(
        repeated.replace("SILENT_REPEAT_VIEWSTATE", "SECOND_REPEAT_VIEWSTATE"),
        "text/xml;charset=UTF-8",
      ),
    ]);
    const adapter = new PjAdapter(config, {
      http,
      logger: createLogger({ runId: "bounded-repeat-test", level: "silent" }),
    });

    await adapter.search({ court: "supreme", query: "derecho", mode: "specialized" });
    await expect(adapter.nextPage()).rejects.toThrow(
      "La página 2 repitió silenciosamente la anterior",
    );
    expect(http.requests.filter((request) => request.page === 2)).toHaveLength(2);
  });

  it("recupera si el target 2 responde como página 1 aunque traiga IDs distintos", async () => {
    const [initial, page1, page2] = await Promise.all([
      fixture("initial.html"),
      fixture("search-page-1.html"),
      fixture("partial-page-2.xml"),
    ]);
    const recoveredPage1 = page1.replaceAll("FIXTURE_VIEWSTATE_1", "RECOVERED_VIEWSTATE_1");
    const wrongPage = distinctRecordsAtWrongPage(page2);
    const http = new QueueTransport([
      response(initial),
      response(page1),
      response(wrongPage, "text/xml;charset=UTF-8"),
      response(initial),
      response(recoveredPage1),
      response(page2, "text/xml;charset=UTF-8"),
    ]);
    const adapter = new PjAdapter(config, {
      http,
      logger: createLogger({ runId: "wrong-target-recovery-test", level: "silent" }),
    });

    const first = await adapter.search({ court: "supreme", query: "derecho", mode: "specialized" });
    const recovered = await adapter.nextPage();

    expect(recovered.pagination.currentPage).toBe(2);
    expect(recovered.records.map(({ nativeId }) => nativeId)).not.toEqual(
      first.records.map(({ nativeId }) => nativeId),
    );
    expect(http.requests.filter((request) => request.page === 2)).toHaveLength(2);
  });

  it("falla estructuralmente tras una segunda respuesta que no alcanza el target", async () => {
    const [initial, page1, page2] = await Promise.all([
      fixture("initial.html"),
      fixture("search-page-1.html"),
      fixture("partial-page-2.xml"),
    ]);
    const recoveredPage1 = page1.replaceAll("FIXTURE_VIEWSTATE_1", "RECOVERED_VIEWSTATE_1");
    const http = new QueueTransport([
      response(initial),
      response(page1),
      response(distinctRecordsAtWrongPage(page2), "text/xml;charset=UTF-8"),
      response(initial),
      response(recoveredPage1),
      response(
        distinctRecordsAtWrongPage(page2, "SECOND_WRONG_PAGE_VIEWSTATE"),
        "text/xml;charset=UTF-8",
      ),
    ]);
    const adapter = new PjAdapter(config, {
      http,
      logger: createLogger({ runId: "bounded-wrong-target-test", level: "silent" }),
    });

    const first = await adapter.search({ court: "supreme", query: "derecho", mode: "specialized" });
    await expect(adapter.nextPage()).rejects.toThrow("La página 2 respondió como página 1");

    expect(http.requests.filter((request) => request.page === 2)).toHaveLength(2);
    expect(adapter.currentResults.pagination.currentPage).toBe(1);
    expect(adapter.currentResults.records.map(({ nativeId }) => nativeId)).toEqual(
      first.records.map(({ nativeId }) => nativeId),
    );
  });

  it("recupera el target N posicionándose directamente en N-1 y reintentando N", async () => {
    const [initial, page1, page2] = await Promise.all([
      fixture("initial.html"),
      fixture("search-page-1.html"),
      fixture("partial-page-2.xml"),
    ]);
    const recoveredPage1 = page1.replaceAll("FIXTURE_VIEWSTATE_1", "RECOVERED_VIEWSTATE_1");
    const wrongPage = retargetPartial(page2, 1, "target incorrecto").replace(
      "FIXTURE_VIEWSTATE_1",
      "WRONG_TARGET_VIEWSTATE",
    );
    const http = new QueueTransport([
      response(initial),
      response(page1),
      response(wrongPage, "text/xml;charset=UTF-8"),
      response(initial),
      response(recoveredPage1),
      response(retargetPartial(page2, 11, "posición recuperada 11"), "text/xml;charset=UTF-8"),
      response(retargetPartial(page2, 12, "target recuperado 12"), "text/xml;charset=UTF-8"),
    ]);
    const adapter = new PjAdapter(config, {
      http,
      logger: createLogger({ runId: "direct-target-recovery-test", level: "silent" }),
    });

    await adapter.search({ court: "supreme", query: "derecho", mode: "specialized" });
    const recovered = await adapter.goToPage(12);

    expect(recovered.pagination.currentPage).toBe(12);
    expect(http.requests.filter(({ page }) => page !== undefined).map(({ page }) => page)).toEqual([
      1, 12, 1, 11, 12,
    ]);
    const paginationBodies = http.requests
      .filter(({ page }) => page === 11 || page === 12)
      .map(({ body }) => String(body));
    expect(paginationBodies).toHaveLength(3);
    expect(paginationBodies[0]).toContain("formBuscador%3Adata1%3Apage=12");
    expect(paginationBodies[1]).toContain("formBuscador%3Adata1%3Apage=11");
    expect(paginationBodies[2]).toContain("formBuscador%3Adata1%3Apage=12");
  });
});
