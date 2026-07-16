import type { Logger } from "pino";

import type { ScraperConfig } from "../../config/env.js";
import { PjHttpClient, type ControlledResponse } from "../../core/http-client.js";
import { buildJsfPostback, JsfStateManager } from "../../core/jsf/index.js";
import type { PjHttpTransport } from "./adapter.js";
import {
  HISTORICAL_FORM_ID,
  HISTORICAL_SEARCH_PATH,
  encodeHistoricalPayload,
  historicalPageControls,
  historicalSearchPayload,
} from "./historical-request-builders.js";
import { parseHistoricalResults, type PjHistoricalParsedResults } from "./historical-parser.js";

function contentType(response: ControlledResponse): string {
  return response.headers["content-type"] ?? "text/html;charset=UTF-8";
}

export class PjHistoricalAdapter {
  readonly #http: PjHttpTransport;
  readonly #config: ScraperConfig;
  readonly #logger: Logger;
  #state = new JsfStateManager(`form#${HISTORICAL_FORM_ID}`);
  #bootstrapHtml: string | undefined;
  #results: PjHistoricalParsedResults | undefined;

  constructor(config: ScraperConfig, dependencies: { http?: PjHttpTransport; logger: Logger }) {
    this.#config = config;
    this.#logger = dependencies.logger;
    this.#http = dependencies.http ?? new PjHttpClient(config, { logger: dependencies.logger });
  }

  get currentResults(): PjHistoricalParsedResults {
    if (this.#results === undefined) throw new Error("La colección histórica no fue abierta");
    return this.#results;
  }

  async preflight(signal?: AbortSignal): Promise<void> {
    if (signal === undefined) await this.#http.preflight(HISTORICAL_SEARCH_PATH);
    else await this.#http.preflight(HISTORICAL_SEARCH_PATH, signal);
  }

  async bootstrap(signal?: AbortSignal): Promise<void> {
    const response = await this.#http.request({
      url: HISTORICAL_SEARCH_PATH,
      method: "GET",
      phase: "discover",
      ...(signal === undefined ? {} : { signal }),
    });
    this.#state = new JsfStateManager(`form#${HISTORICAL_FORM_ID}`);
    this.#state.accept({
      effectiveUrl: response.url,
      contentType: contentType(response),
      body: response.data,
      status: response.status,
    });
    this.#bootstrapHtml = response.data;
    this.#results = undefined;
  }

  async search(signal?: AbortSignal): Promise<PjHistoricalParsedResults> {
    if (this.#bootstrapHtml === undefined) await this.bootstrap(signal);
    const html = this.#bootstrapHtml;
    if (html === undefined) throw new Error("Bootstrap histórico incompleto");
    const response = await this.#http.request({
      url: this.#state.current.action,
      method: "POST",
      phase: "discover",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: encodeHistoricalPayload(
        historicalSearchPayload(html, this.#state.current.successfulControls),
      ),
      ...(signal === undefined ? {} : { signal }),
      page: 1,
    });
    this.#state.accept({
      effectiveUrl: response.url,
      contentType: contentType(response),
      body: response.data,
      status: response.status,
    });
    const parsed = parseHistoricalResults(response.data, { baseUrl: this.#config.baseUrl });
    this.#results = parsed;
    return parsed;
  }

  async nextPage(signal?: AbortSignal): Promise<PjHistoricalParsedResults> {
    const current = this.currentResults;
    if (current.pagination.endSignal === "natural_end") {
      throw new Error("La colección histórica alcanzó su fin natural");
    }
    const target = current.pagination.currentPage + 1;
    const response = await this.#http.requestStateful({
      buildRequest: () => {
        const postback = buildJsfPostback(this.#state.current, {
          append: historicalPageControls(this.currentResults.scrollerSource, target),
        });
        return {
          url: postback.url,
          method: "POST",
          phase: "discover",
          headers: { "content-type": postback.contentType },
          body: postback.body,
          expectedAjaxUpdate: /javax\.faces\.ViewState/u,
          ...(signal === undefined ? {} : { signal }),
          page: target,
        };
      },
      restorePage: async () => {
        this.#logger.warn({ page: target }, "Reconstruyendo sesión de la colección histórica");
        await this.#recoverToPage(target - 1, signal);
      },
    });
    this.#state.accept({
      effectiveUrl: response.url,
      contentType: contentType(response),
      body: response.data,
      status: response.status,
    });
    const parsed = parseHistoricalResults(response.data, {
      baseUrl: this.#config.baseUrl,
      currentPage: target,
      queryTotal: current.queryTotal,
      pageSize: current.pagination.pageSize,
    });
    if (parsed.fingerprint === current.fingerprint) {
      throw new Error(`La página histórica ${String(target)} repitió la anterior`);
    }
    this.#results = parsed;
    return parsed;
  }

  async #recoverToPage(page: number, signal?: AbortSignal): Promise<void> {
    await this.bootstrap(signal);
    await this.search(signal);
    for (let target = 2; target <= page; target += 1) await this.nextPage(signal);
  }
}
