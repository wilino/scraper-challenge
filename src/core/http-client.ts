import axios, {
  AxiosError,
  AxiosHeaders,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type Method,
  type RawAxiosHeaders,
} from "axios";
import { wrapper } from "axios-cookiejar-support";
import type { Readable } from "node:stream";
import type { Logger } from "pino";
import { CookieJar } from "tough-cookie";

import type { ScraperConfig } from "../config/env.js";
import { HttpRequestError, PreflightError } from "./http-errors.js";
import { type Clock, RateLimiter, SharedHostCooldown, systemClock } from "./rate-limiter.js";
import { RedirectPolicy } from "./redirect-policy.js";
import { RequestMetrics, type HttpPhase } from "./request-metrics.js";
import { parseRetryAfter, RetryPolicy } from "./retry-policy.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TRANSIENT_STATUSES = new Set([408, 502, 503, 504]);
const PERMANENT_STATUSES = new Set([400, 401, 404, 410]);
const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]);
const TLS_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

export type ResponseKind = "html" | "pdf";

export interface ControlledRequest {
  url: string | URL;
  method?: Method;
  phase: HttpPhase;
  kind?: ResponseKind;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  expectedAjaxUpdate?: string | RegExp | ((body: string) => boolean);
  page?: number;
  documentId?: string;
  responseMode?: "buffer" | "stream";
  omitSession?: boolean;
}

export interface ControlledResponse<T = string | Uint8Array | Readable> {
  status: number;
  headers: Readonly<Record<string, string>>;
  data: T;
  url: string;
  attempts: number;
}

export interface StatefulRequest<T = string | Uint8Array> {
  buildRequest: (attempt: number) => ControlledRequest;
  rebootstrap: (reason: HttpRequestError) => Promise<void>;
  maxRebootstraps?: number;
  transform?: (response: ControlledResponse) => T;
}

export interface HttpClientDependencies {
  clock?: Clock;
  random?: () => number;
  logger: Logger;
  jar?: CookieJar;
  axiosInstance?: AxiosInstance;
  statelessAxiosInstance?: AxiosInstance;
}

interface ClassifiedResponse {
  error?: HttpRequestError;
  retryAfter?: string;
}

interface RequestFailure {
  error: HttpRequestError;
  retryAfter?: string;
}

function headerValue(headers: AxiosResponse["headers"], name: string): string | undefined {
  const value = AxiosHeaders.from(headers as RawAxiosHeaders).get(name);
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.join(", ");
  return undefined;
}

function safeHeaders(headers: AxiosResponse["headers"]): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (/^(?:set-cookie|cookie|authorization)$/i.test(name)) continue;
    if (typeof value === "string") result[name] = value;
    else if (typeof value === "number") result[name] = String(value);
    else if (Array.isArray(value)) result[name] = value.join(", ");
  }
  return result;
}

function isEmptyXml(response: AxiosResponse): boolean {
  const contentType = headerValue(response.headers, "content-type")?.toLowerCase() ?? "";
  return contentType.includes("text/xml") && String(response.data ?? "").trim() === "";
}

function containsExpectedUpdate(
  body: string,
  expected: NonNullable<ControlledRequest["expectedAjaxUpdate"]>,
): boolean {
  if (typeof expected === "function") return expected(body);
  if (expected instanceof RegExp) return expected.test(body);
  return body.includes(expected);
}

function abortError(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error("solicitud abortada");
}

export class PjHttpClient {
  private readonly axios: AxiosInstance;
  private readonly statelessAxios: AxiosInstance;
  private readonly clock: Clock;
  private readonly retryPolicy: RetryPolicy;
  private readonly redirectPolicy: RedirectPolicy;
  private readonly cooldown: SharedHostCooldown;
  private readonly htmlLimiter: RateLimiter;
  private readonly pdfLimiter: RateLimiter;
  private readonly metrics: RequestMetrics;

  public readonly jar: CookieJar;

  public constructor(
    private readonly config: ScraperConfig,
    dependencies: HttpClientDependencies,
  ) {
    this.clock = dependencies.clock ?? systemClock;
    const random = dependencies.random ?? Math.random;
    this.jar = dependencies.jar ?? new CookieJar();
    this.axios =
      dependencies.axiosInstance ??
      wrapper(
        axios.create({
          jar: this.jar,
          maxRedirects: 0,
          validateStatus: () => true,
          proxy: false,
        }),
      );
    this.statelessAxios =
      dependencies.statelessAxiosInstance ??
      axios.create({
        maxRedirects: 0,
        validateStatus: () => true,
        proxy: false,
      });
    this.retryPolicy = new RetryPolicy({
      maxRetries: config.maxRetries,
      backoffBaseMs: config.backoffBaseMs,
      backoffMaxMs: config.backoffMaxMs,
      random,
      now: () => this.clock.now(),
    });
    this.redirectPolicy = new RedirectPolicy(config.baseUrl);
    this.cooldown = new SharedHostCooldown(this.clock);
    this.htmlLimiter = new RateLimiter({
      concurrency: config.htmlConcurrency,
      minDelayMs: config.minRequestDelayMs,
      maxDelayMs: config.maxRequestDelayMs,
      cooldown: this.cooldown,
      clock: this.clock,
      random,
    });
    this.pdfLimiter = new RateLimiter({
      concurrency: config.pdfConcurrency,
      minDelayMs: config.minRequestDelayMs,
      maxDelayMs: config.maxRequestDelayMs,
      cooldown: this.cooldown,
      clock: this.clock,
      random,
    });
    this.metrics = new RequestMetrics(dependencies.logger);
  }

  public async request<T = string | Uint8Array>(
    request: ControlledRequest,
  ): Promise<ControlledResponse<T>> {
    return (await this.execute(() => request)) as ControlledResponse<T>;
  }

  public metricSnapshot(): { rateLimitResponses: number } {
    return this.metrics.snapshot();
  }

  public async requestPdfStream(
    url: string | URL,
    documentId: string,
    signal?: AbortSignal,
  ): Promise<ControlledResponse<Readable>> {
    return await this.request<Readable>({
      url,
      method: "GET",
      phase: "download",
      kind: "pdf",
      responseMode: "stream",
      omitSession: true,
      documentId,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async requestStateful<T = string | Uint8Array>(
    stateful: StatefulRequest<T>,
  ): Promise<ControlledResponse<T>> {
    let rebootstraps = 0;
    const response = await this.execute(stateful.buildRequest, async (reason) => {
      const maxRebootstraps = stateful.maxRebootstraps ?? 1;
      if (rebootstraps >= maxRebootstraps) throw reason;
      rebootstraps += 1;
      await stateful.rebootstrap(reason);
    });
    if (stateful.transform === undefined) return response as ControlledResponse<T>;
    return { ...response, data: stateful.transform(response) };
  }

  public async preflight(path = this.config.startPath, signal?: AbortSignal): Promise<void> {
    try {
      await this.request({
        url: path,
        phase: "preflight",
        method: "GET",
        kind: "html",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error: unknown) {
      if (error instanceof HttpRequestError) {
        const code = error.code;
        if (error.classification === "access") {
          throw new PreflightError(
            "access",
            "PJ respondió 403. Verifique que la salida autorizada sea desde Perú (directa o por VPN).",
            error.safePath,
            code,
          );
        }
        if (error.classification === "security") {
          throw new PreflightError(
            "redirect",
            "PJ devolvió un redirect no permitido.",
            error.safePath,
            code,
          );
        }
        if (error.classification === "timeout") {
          throw new PreflightError(
            "timeout",
            "PJ no respondió dentro del tiempo configurado.",
            error.safePath,
            code,
          );
        }
        if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
          throw new PreflightError(
            "dns",
            "No se pudo resolver el host de PJ.",
            error.safePath,
            code,
          );
        }
        if (
          code !== undefined &&
          (code.startsWith("CERT_") || code.includes("TLS") || TLS_CODES.has(code))
        ) {
          throw new PreflightError(
            "tls",
            "Falló la validación TLS del host de PJ.",
            error.safePath,
            code,
          );
        }
        throw new PreflightError("network", "No se pudo conectar con PJ.", error.safePath, code);
      }
      throw error;
    }
  }

  private async execute(
    buildRequest: (attempt: number) => ControlledRequest,
    rebootstrap?: (reason: HttpRequestError) => Promise<void>,
  ): Promise<ControlledResponse> {
    let attempt = 1;
    for (;;) {
      const request = buildRequest(attempt);
      const limiter = (request.kind ?? "html") === "pdf" ? this.pdfLimiter : this.htmlLimiter;
      const outcome = await limiter.schedule(
        async () => await this.attempt(request, attempt),
        request.signal,
      );
      if (!("error" in outcome)) return { ...outcome, attempts: attempt };

      if (outcome.error.requiresRebootstrap) {
        if (rebootstrap === undefined) throw outcome.error;
        await rebootstrap(outcome.error);
      }
      const decision = this.retryPolicy.decide(
        attempt,
        outcome.error.retryable,
        outcome.retryAfter,
      );
      if (outcome.error.classification === "rate_limit") {
        const cooldownDelay = decision.retry
          ? decision.delayMs
          : (parseRetryAfter(outcome.retryAfter, this.clock.now()) ??
            this.config.globalCooldownAfter429Ms);
        this.cooldown.pauseFor(cooldownDelay);
      }
      if (!decision.retry) throw outcome.error;
      this.metrics.record({
        phase: request.phase,
        method: request.method ?? "GET",
        safePath: outcome.error.safePath,
        attempt,
        durationMs: 0,
        status: outcome.error.status,
        code: outcome.error.code,
        delayMs: decision.delayMs,
        cause: outcome.error.classification,
        page: request.page,
        documentId: request.documentId,
      });
      await this.clock.sleep(decision.delayMs, request.signal);
      attempt += 1;
    }
  }

  private async attempt(
    request: ControlledRequest,
    attempt: number,
  ): Promise<Omit<ControlledResponse, "attempts"> | RequestFailure> {
    let url = this.redirectPolicy.validateRequest(request.url);
    let method = request.method ?? "GET";
    let body = request.body;
    let redirectCount = 0;
    const startedAt = this.clock.now();
    try {
      for (;;) {
        const response = await this.send(url, method, body, request);
        const status = response.status;
        if (REDIRECT_STATUSES.has(status)) {
          const location = headerValue(response.headers, "location");
          if (location === undefined || redirectCount >= 5) {
            throw new HttpRequestError("Redirect inválido o excesivo", {
              classification: "security",
              retryable: false,
              safePath: url.pathname,
              attempt,
              status,
              code: "ERR_UNSAFE_REDIRECT",
            });
          }
          url = this.redirectPolicy.resolveRedirect(url, location);
          redirectCount += 1;
          if (
            status === 303 ||
            ((status === 301 || status === 302) && method.toUpperCase() === "POST")
          ) {
            method = "GET";
            body = undefined;
          }
          continue;
        }
        const classified = this.classifyResponse(response, request, attempt, url.pathname);
        this.metrics.record({
          phase: request.phase,
          method,
          safePath: url.pathname,
          attempt,
          durationMs: this.clock.now() - startedAt,
          status,
          cause: classified.error?.classification,
          page: request.page,
          documentId: request.documentId,
        });
        if (classified.error !== undefined) {
          const failure: RequestFailure = { error: classified.error };
          if (classified.retryAfter !== undefined) failure.retryAfter = classified.retryAfter;
          return failure;
        }
        const data =
          request.responseMode === "stream"
            ? (response.data as Readable)
            : (request.kind ?? "html") === "pdf"
              ? new Uint8Array(response.data as ArrayBuffer)
              : String(response.data);
        return { status, headers: safeHeaders(response.headers), data, url: url.toString() };
      }
    } catch (error: unknown) {
      const classified = this.classifyThrown(error, url.pathname, attempt, request.signal);
      this.metrics.record({
        phase: request.phase,
        method,
        safePath: url.pathname,
        attempt,
        durationMs: this.clock.now() - startedAt,
        code: classified.code,
        cause: classified.classification,
        page: request.page,
        documentId: request.documentId,
      });
      return { error: classified };
    }
  }

  private async send(
    url: URL,
    method: Method,
    body: unknown,
    request: ControlledRequest,
  ): Promise<AxiosResponse> {
    if (request.signal?.aborted === true) throw abortError(request.signal);
    const kind = request.kind ?? "html";
    const totalTimeout = kind === "pdf" ? this.config.pdfTimeoutMs : this.config.requestTimeoutMs;
    const totalController = new AbortController();
    const timer = setTimeout(() => {
      totalController.abort(new Error(`timeout total de ${String(totalTimeout)} ms`));
    }, totalTimeout);
    const abortExternal = () => {
      totalController.abort(abortError(request.signal));
    };
    request.signal?.addEventListener("abort", abortExternal, { once: true });
    const requestHeaders = Object.fromEntries(
      Object.entries({ "User-Agent": this.config.userAgent, ...request.headers }).filter(
        ([name]) => !/^(?:cookie|authorization)$/i.test(name),
      ),
    );
    if (request.omitSession !== true) {
      const cookie = await this.jar.getCookieString(url.toString());
      if (cookie !== "") requestHeaders.Cookie = cookie;
    }
    const axiosConfig: AxiosRequestConfig = {
      url: url.toString(),
      method,
      data: body,
      headers: requestHeaders,
      signal: totalController.signal,
      timeout: this.config.connectTimeoutMs,
      responseType:
        request.responseMode === "stream" ? "stream" : kind === "pdf" ? "arraybuffer" : "text",
      maxContentLength: kind === "pdf" ? this.config.maxPdfBytes : this.config.maxHtmlBytes,
      maxBodyLength: this.config.maxHtmlBytes,
      maxRedirects: 0,
      validateStatus: () => true,
    };
    try {
      const transport = request.omitSession === true ? this.statelessAxios : this.axios;
      const response = await transport.request(axiosConfig);
      if (request.omitSession !== true) {
        const setCookies = AxiosHeaders.from(response.headers as RawAxiosHeaders).getSetCookie();
        for (const setCookie of setCookies) await this.jar.setCookie(setCookie, url.toString());
      }
      return response;
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abortExternal);
    }
  }

  private classifyResponse(
    response: AxiosResponse,
    request: ControlledRequest,
    attempt: number,
    safePath: string,
  ): ClassifiedResponse {
    const status = response.status;
    const retryAfter = headerValue(response.headers, "retry-after");
    const base = { safePath, attempt, status };
    if (status === 429) {
      const retryAfterMs = parseRetryAfter(retryAfter, this.clock.now());
      return {
        error: new HttpRequestError("PJ limitó temporalmente las solicitudes", {
          ...base,
          classification: "rate_limit",
          retryable: true,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        }),
        ...(retryAfter === undefined ? {} : { retryAfter }),
      };
    }
    if (status === 403) {
      return {
        error: new HttpRequestError(
          request.phase === "preflight"
            ? "Acceso inicial rechazado por PJ"
            : "La sesión PJ perdió autorización",
          {
            ...base,
            classification: "access",
            retryable: request.phase !== "preflight" && attempt === 1,
            requiresRebootstrap: request.phase !== "preflight" && attempt === 1,
          },
        ),
      };
    }
    if (status === 500 && isEmptyXml(response)) {
      return {
        error: new HttpRequestError(
          "PJ devolvió una respuesta AJAX vacía; la sesión debe reiniciarse",
          {
            ...base,
            classification: "session_invalid",
            retryable: true,
            requiresRebootstrap: true,
          },
        ),
      };
    }
    if (status === 200 && request.expectedAjaxUpdate !== undefined) {
      const responseBody = String(response.data ?? "");
      if (!containsExpectedUpdate(responseBody, request.expectedAjaxUpdate)) {
        return {
          error: new HttpRequestError("La respuesta AJAX no contiene el panel esperado", {
            ...base,
            classification: "structural",
            retryable: true,
            requiresRebootstrap: true,
          }),
        };
      }
    }
    if (TRANSIENT_STATUSES.has(status)) {
      return {
        error: new HttpRequestError(`PJ respondió con estado transitorio ${String(status)}`, {
          ...base,
          classification: "http_transient",
          retryable: true,
        }),
        ...(retryAfter === undefined ? {} : { retryAfter }),
      };
    }
    if (PERMANENT_STATUSES.has(status) || status >= 400) {
      return {
        error: new HttpRequestError(`PJ respondió con estado permanente ${String(status)}`, {
          ...base,
          classification: "http_permanent",
          retryable: false,
        }),
      };
    }
    return {};
  }

  private classifyThrown(
    error: unknown,
    safePath: string,
    attempt: number,
    externalSignal?: AbortSignal,
  ): HttpRequestError {
    if (error instanceof HttpRequestError) return error;
    const axiosError = error instanceof AxiosError ? error : undefined;
    const code =
      axiosError?.code ??
      (error instanceof Error && "code" in error ? String(error.code) : undefined);
    if (externalSignal?.aborted === true) {
      return new HttpRequestError("Solicitud interrumpida", {
        classification: "interrupted",
        retryable: false,
        safePath,
        attempt,
        code: "ERR_CANCELED",
        cause: error,
      });
    }
    if (code === "ECONNABORTED" || code === "ERR_CANCELED" || code === "ETIMEDOUT") {
      return new HttpRequestError("La solicitud a PJ agotó el tiempo configurado", {
        classification: "timeout",
        retryable: true,
        safePath,
        attempt,
        code,
        cause: error,
      });
    }
    if (code === "ERR_FR_MAX_BODY_LENGTH_EXCEEDED" || code === "ERR_BAD_RESPONSE") {
      return new HttpRequestError("La respuesta excede el límite de tamaño configurado", {
        classification: "invalid_content",
        retryable: false,
        safePath,
        attempt,
        code,
        cause: error,
      });
    }
    return new HttpRequestError("Error de red al contactar PJ", {
      classification: "network",
      retryable: code !== undefined && TRANSIENT_CODES.has(code),
      safePath,
      attempt,
      ...(code === undefined ? {} : { code }),
      cause: error,
    });
  }
}
