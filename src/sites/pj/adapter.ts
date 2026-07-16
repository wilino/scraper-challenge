import type { Logger } from "pino";

import type { ScraperConfig } from "../../config/env.js";
import {
  PjHttpClient,
  type ControlledRequest,
  type ControlledResponse,
  type StatefulRequest,
} from "../../core/http-client.js";
import { buildJsfPostback, JsfStateManager } from "../../core/jsf/index.js";
import type { OrderedPairs } from "../../models/index.js";
import {
  mergeListAndDetail,
  parseDetail,
  parseResultsPage,
  type PjListRecord,
  type PjParsedDetail,
  type PjParsedResults,
} from "./parser.js";
import {
  buildSearchPayload,
  detailAjaxControls,
  encodePayload,
  pageAjaxControls,
  type SearchPayloadOptions,
} from "./request-builders.js";
import { DETAIL_POPUP_BY_COURT, PJ_SELECTORS, type PjCourt } from "./selectors.js";

export interface PjAdapterDependencies {
  http?: PjHttpTransport;
  logger: Logger;
}

export interface PjHttpTransport {
  preflight(path?: string, signal?: AbortSignal): Promise<void>;
  request(request: ControlledRequest): Promise<ControlledResponse<string>>;
  requestStateful(request: StatefulRequest<string>): Promise<ControlledResponse<string>>;
}

export interface CompletePjRecord {
  list: PjListRecord;
  detail: PjParsedDetail;
  merged: ReturnType<typeof mergeListAndDetail>;
}

export class PjAdapterStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PjAdapterStateError";
  }
}

function contentType(response: ControlledResponse): string {
  return response.headers["content-type"] ?? "text/html;charset=UTF-8";
}

function pageResponseMismatch(
  parsed: PjParsedResults,
  previous: PjParsedResults,
  targetPage: number,
): string | undefined {
  if (parsed.pagination.currentPage !== targetPage) {
    return `La página ${String(targetPage)} respondió como página ${String(parsed.pagination.currentPage)}`;
  }
  if (parsed.fingerprint === previous.fingerprint) {
    return `La página ${String(targetPage)} repitió silenciosamente la anterior`;
  }
  return undefined;
}

export class PjAdapter {
  readonly #http: PjHttpTransport;
  readonly #config: ScraperConfig;
  readonly #logger: Logger;
  #state = new JsfStateManager(PJ_SELECTORS.form);
  #bootstrapHtml: string | undefined;
  #search: SearchPayloadOptions | undefined;
  #results: PjParsedResults | undefined;

  constructor(config: ScraperConfig, dependencies: PjAdapterDependencies) {
    this.#config = config;
    this.#logger = dependencies.logger;
    this.#http = dependencies.http ?? new PjHttpClient(config, { logger: dependencies.logger });
  }

  get currentResults(): PjParsedResults {
    if (this.#results === undefined) {
      throw new PjAdapterStateError("La búsqueda PJ aún no fue inicializada");
    }
    return this.#results;
  }

  async preflight(signal?: AbortSignal): Promise<void> {
    if (signal === undefined) await this.#http.preflight(this.#config.startPath);
    else await this.#http.preflight(this.#config.startPath, signal);
  }

  async bootstrap(signal?: AbortSignal): Promise<void> {
    const response = await this.#http.request({
      url: this.#config.startPath,
      method: "GET",
      phase: "discover",
      ...(signal === undefined ? {} : { signal }),
    });
    this.#state = new JsfStateManager(PJ_SELECTORS.form);
    this.#state.accept({
      effectiveUrl: response.url,
      contentType: contentType(response),
      body: response.data,
      status: response.status,
    });
    this.#bootstrapHtml = response.data;
    this.#results = undefined;
  }

  async search(options: SearchPayloadOptions, signal?: AbortSignal): Promise<PjParsedResults> {
    if (this.#bootstrapHtml === undefined) await this.bootstrap(signal);
    const html = this.#bootstrapHtml;
    if (html === undefined) throw new PjAdapterStateError("Bootstrap PJ incompleto");
    const response = await this.#http.request({
      url: this.#state.current.action,
      method: "POST",
      phase: "discover",
      body: encodePayload(buildSearchPayload(html, options)),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      ...(signal === undefined ? {} : { signal }),
      page: 1,
    });
    this.#state.accept({
      effectiveUrl: response.url,
      contentType: contentType(response),
      body: response.data,
      status: response.status,
    });
    const parsed = parseResultsPage(response.data, { baseUrl: this.#config.baseUrl });
    this.#search = options;
    this.#results = parsed;
    return parsed;
  }

  async nextPage(signal?: AbortSignal): Promise<PjParsedResults> {
    const current = this.currentResults;
    if (current.pagination.endSignal === "natural_end") {
      throw new PjAdapterStateError("La búsqueda PJ ya alcanzó su fin natural");
    }
    return this.#requestPage(current.pagination.currentPage + 1, true, signal);
  }

  async goToPage(page: number, signal?: AbortSignal): Promise<PjParsedResults> {
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new PjAdapterStateError(`Página PJ inválida: ${String(page)}`);
    }
    if (page === this.currentResults.pagination.currentPage) return this.currentResults;
    return this.#requestPage(page, true, signal);
  }

  async fetchDetail(record: PjListRecord, signal?: AbortSignal): Promise<CompletePjRecord> {
    const court = this.#court();
    const expectedPanel = DETAIL_POPUP_BY_COURT[court];
    const response = await this.#requestStateful(
      detailAjaxControls(record.detail),
      "detail",
      expectedPanel,
      this.currentResults.pagination.currentPage,
      signal,
      record.nativeId,
    );
    this.#acceptPartial(response, expectedPanel);
    const detail = parseDetail(response.data, court, this.#config.baseUrl);
    for (const warning of detail.warnings)
      this.#logger.warn({ documentId: record.nativeId }, warning);
    return { list: record, detail, merged: mergeListAndDetail(record, detail) };
  }

  async #requestPage(
    page: number,
    recover: boolean,
    signal?: AbortSignal,
  ): Promise<PjParsedResults> {
    const previous = this.currentResults;
    const response = recover
      ? await this.#requestStateful(
          pageAjaxControls(page),
          "paginate",
          "formBuscador:panel",
          page,
          signal,
        )
      : await this.#requestAjax(pageAjaxControls(page), "paginate", page, signal);
    const parsed = parseResultsPage(response.data, {
      baseUrl: this.#config.baseUrl,
      currentPage: page,
      queryTotal: previous.queryTotal,
      publishedGlobalTotal: previous.publishedGlobalTotal,
      previousViewState: previous.viewState,
      requireChangedViewState: true,
    });
    const mismatch = pageResponseMismatch(parsed, previous, page);
    if (mismatch !== undefined) {
      if (recover) {
        this.#logger.warn(
          { page, receivedPage: parsed.pagination.currentPage, reason: mismatch },
          "PJ no alcanzó la página objetivo; reconstruyendo la sesión JSF",
        );
        await this.#recoverToPage(page - 1, signal);
        return this.#requestPage(page, false, signal);
      }
      throw new PjAdapterStateError(mismatch);
    }
    this.#acceptPartial(response, "formBuscador:panel");
    this.#results = parsed;
    return parsed;
  }

  async #requestStateful(
    append: OrderedPairs,
    phase: "paginate" | "detail",
    expectedUpdate: string,
    page: number,
    signal?: AbortSignal,
    documentId?: string,
  ): Promise<ControlledResponse<string>> {
    return this.#http.requestStateful({
      buildRequest: () => {
        const postback = buildJsfPostback(this.#state.current, { append });
        return {
          url: postback.url,
          method: "POST",
          phase: phase === "paginate" ? "discover" : "detail",
          body: postback.body,
          headers: { "content-type": postback.contentType },
          expectedAjaxUpdate: expectedUpdate,
          ...(signal === undefined ? {} : { signal }),
          page,
          ...(documentId === undefined ? {} : { documentId }),
        };
      },
      rebootstrap: async () => {
        await this.#recoverToPage(page - (phase === "paginate" ? 1 : 0), signal);
      },
      maxRebootstraps: 1,
    });
  }

  async #requestAjax(
    append: OrderedPairs,
    phase: "paginate" | "detail",
    page: number,
    signal?: AbortSignal,
  ): Promise<ControlledResponse<string>> {
    const postback = buildJsfPostback(this.#state.current, { append });
    return this.#http.request({
      url: postback.url,
      method: "POST",
      phase: phase === "paginate" ? "discover" : "detail",
      body: postback.body,
      headers: { "content-type": postback.contentType },
      ...(phase === "paginate" ? { expectedAjaxUpdate: "formBuscador:panel" } : {}),
      ...(signal === undefined ? {} : { signal }),
      page,
    });
  }

  #acceptPartial(response: ControlledResponse<string>, requiredUpdateId: string): void {
    this.#state.accept(
      {
        effectiveUrl: response.url,
        contentType: contentType(response),
        body: response.data,
        status: response.status,
      },
      { requiredUpdateId },
    );
  }

  async #recoverToPage(page: number, signal?: AbortSignal): Promise<void> {
    const search = this.#search;
    if (search === undefined) throw new PjAdapterStateError("No existe búsqueda para recuperar");
    await this.bootstrap(signal);
    await this.search(search, signal);
    if (page > 1) await this.#requestPage(page, false, signal);
  }

  #court(): PjCourt {
    const court = this.#search?.court;
    if (court === undefined) throw new PjAdapterStateError("No existe una corte activa");
    return court;
  }
}
