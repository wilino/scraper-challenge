import { readFile } from "node:fs/promises";

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
});
