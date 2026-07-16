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
  maxPages: 2,
  maxDocuments: 20,
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

class QueueTransport implements PjHttpTransport {
  readonly requests: ControlledRequest[] = [];
  readonly preflight = vi.fn(async () => {
    await Promise.resolve();
  });

  constructor(
    private readonly responses: ControlledResponse<string>[],
    private readonly recoverFirstStateful = false,
  ) {}

  request(request: ControlledRequest): Promise<ControlledResponse<string>> {
    this.requests.push(request);
    return Promise.resolve(this.take());
  }

  async requestStateful(request: StatefulRequest<string>): Promise<ControlledResponse<string>> {
    this.requests.push(request.buildRequest(1));
    if (this.recoverFirstStateful) {
      await request.rebootstrap(
        new HttpRequestError("vista expirada de prueba", {
          classification: "transient",
          retryable: true,
          requiresRebootstrap: true,
          safePath: config.resultsPath,
          attempt: 1,
        }),
      );
      this.requests.push(request.buildRequest(2));
    }
    return this.take();
  }

  private take(): ControlledResponse<string> {
    const next = this.responses.shift();
    if (next === undefined) throw new Error("Respuesta de prueba no configurada");
    return next;
  }
}

describe("flujo HTTP stateful del adaptador PJ", () => {
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
    const first = await adapter.search({ court: "supreme", query: "derecho" });
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
      await requestFixture("search-page-1.urlencoded"),
      await requestFixture("page-2.urlencoded"),
      await requestFixture("detail.urlencoded"),
    ]);
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

    await adapter.search({ court: "supreme", query: "derecho" });
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

    const first = await adapter.search({ court: "supreme", query: "derecho" });
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

    await adapter.search({ court: "supreme", query: "derecho" });
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

    const first = await adapter.search({ court: "supreme", query: "derecho" });
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

    const first = await adapter.search({ court: "supreme", query: "derecho" });
    await expect(adapter.nextPage()).rejects.toThrow("La página 2 respondió como página 1");

    expect(http.requests.filter((request) => request.page === 2)).toHaveLength(2);
    expect(adapter.currentResults.pagination.currentPage).toBe(1);
    expect(adapter.currentResults.records.map(({ nativeId }) => nativeId)).toEqual(
      first.records.map(({ nativeId }) => nativeId),
    );
  });
});
