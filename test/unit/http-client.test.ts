import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import axios, { AxiosError } from "axios";
import nock from "nock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type ScraperConfig } from "../../src/config/env.js";
import { PreflightError } from "../../src/core/http-errors.js";
import { PjHttpClient } from "../../src/core/http-client.js";
import { createLogger } from "../../src/core/logger.js";
import type { Clock } from "../../src/core/rate-limiter.js";

const origin = "https://jurisprudencia.pj.gob.pe";
const pathName = "/jurisprudenciaweb/faces/page/inicio.xhtml";
const pdfPath = "/jurisprudenciaweb/ServletDescarga?uuid=123";

class ImmediateClock implements Clock {
  public time = Date.parse("2026-07-16T12:00:00.000Z");
  public readonly sleeps: number[] = [];

  public now(): number {
    return this.time;
  }

  public async sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
    this.time += milliseconds;
    await Promise.resolve();
  }
}

interface PendingSleep {
  target: number;
  resolve: () => void;
}

class ControlledClock implements Clock {
  private time = 0;
  private readonly pending: PendingSleep[] = [];

  public now(): number {
    return this.time;
  }

  public get pendingCount(): number {
    return this.pending.length;
  }

  public async sleep(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) return;
    await new Promise<void>((resolve) => {
      this.pending.push({ target: this.time + milliseconds, resolve });
    });
  }

  public advanceBy(milliseconds: number): void {
    this.time += milliseconds;
    const ready = this.pending.filter(({ target }) => target <= this.time);
    for (const sleep of ready) {
      this.pending.splice(this.pending.indexOf(sleep), 1);
      sleep.resolve();
    }
  }
}

function config(overrides: Partial<ScraperConfig> = {}): ScraperConfig {
  const output = mkdtempSync(path.join(tmpdir(), "pj-http-"));
  return {
    ...loadConfig({ OUTPUT_DIR: output }),
    minRequestDelayMs: 0,
    maxRequestDelayMs: 0,
    maxRetries: 2,
    backoffBaseMs: 100,
    backoffMaxMs: 1000,
    ...overrides,
  };
}

function client(
  clock: Clock = new ImmediateClock(),
  overrides: Partial<ScraperConfig> = {},
  destination?: Writable,
): PjHttpClient {
  return new PjHttpClient(config(overrides), {
    clock,
    random: () => 0.5,
    logger: createLogger({
      runId: "run-http",
      level: destination === undefined ? "silent" : "info",
      destination,
    }),
  });
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("cliente HTTP PJ", () => {
  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it("conserva la cookie de bootstrap para el POST del mismo origen", async () => {
    nock(origin).get(pathName).reply(200, "bootstrap", { "Set-Cookie": "JSESSIONID=abc; Path=/" });
    nock(origin)
      .post("/jurisprudenciaweb/faces/page/resultado.xhtml")
      .matchHeader("cookie", /JSESSIONID=abc/)
      .reply(200, "resultado");
    const http = client();

    await http.request({ url: pathName, method: "GET", phase: "discover" });
    const response = await http.request({
      url: "/jurisprudenciaweb/faces/page/resultado.xhtml",
      method: "POST",
      phase: "discover",
      body: "x=1",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    expect(response.data).toBe("resultado");
    expect(nock.isDone()).toBe(true);
  });

  it("bloquea otro origen antes de poder enviar cookies", async () => {
    const external = nock("https://example.com").get("/jurisprudenciaweb/x").reply(200, "no");
    const http = client();
    await http.jar.setCookie("JSESSIONID=abc", origin);

    await expect(
      http.request({ url: "https://example.com/jurisprudenciaweb/x", phase: "discover" }),
    ).rejects.toMatchObject({ classification: "security" });
    expect(external.isDone()).toBe(false);
  });

  it("supera 429 con segundos, luego sin header, y registra tres intentos", async () => {
    const clock = new ImmediateClock();
    nock(origin)
      .get(pdfPath)
      .reply(429, "límite", { "Retry-After": "2" })
      .get(pdfPath)
      .reply(429, "límite")
      .get(pdfPath)
      .reply(200, Buffer.from("%PDF"));
    const response = await client(clock).request<Uint8Array>({
      url: pdfPath,
      phase: "download",
      kind: "pdf",
    });

    expect(response.attempts).toBe(3);
    expect(Buffer.from(response.data).toString()).toBe("%PDF");
    expect(clock.sleeps.filter((delay) => delay > 0)).toEqual([2000, 100]);
  });

  it("descarga por stream tras 429 sin reutilizar cookies de descubrimiento", async () => {
    const clock = new ImmediateClock();
    let receivedCookie: string | string[] | undefined;
    nock(origin)
      .get(pdfPath)
      .reply(429, "límite", { "Retry-After": "1" })
      .get(pdfPath)
      .reply(function replyPdf() {
        receivedCookie = this.req.headers.cookie;
        return [200, Buffer.from("%PDF-stream"), { "Content-Type": "application/octet-stream" }];
      });
    const http = client(clock, { maxRetries: 1 });
    await http.jar.setCookie("JSESSIONID=descubrimiento", origin);

    const response = await http.requestPdfStream(pdfPath, "documento-1");
    const chunks: Buffer[] = [];
    for await (const chunk of response.data) chunks.push(chunk as Buffer);

    expect(Buffer.concat(chunks).toString()).toBe("%PDF-stream");
    expect(response.attempts).toBe(2);
    expect(receivedCookie).toBeUndefined();
    expect(clock.sleeps.filter((delay) => delay > 0)).toEqual([1000]);
  });

  it("respeta Retry-After como fecha futura", async () => {
    const clock = new ImmediateClock();
    nock(origin)
      .get(pathName)
      .reply(503, "ocupado", { "Retry-After": "Thu, 16 Jul 2026 12:00:03 GMT" })
      .get(pathName)
      .reply(200, "ok");
    const response = await client(clock).request({ url: pathName, phase: "discover" });
    expect(response.data).toBe("ok");
    expect(clock.sleeps.filter((delay) => delay > 0)).toEqual([3000]);
  });

  it("reintenta un 500 temporal durante detail y luego continúa", async () => {
    nock(origin)
      .post("/jurisprudenciaweb/faces/page/resultado.xhtml")
      .reply(500, "backend temporalmente no disponible")
      .post("/jurisprudenciaweb/faces/page/resultado.xhtml")
      .reply(200, '<partial-response><update id="panel">ok</update></partial-response>', {
        "Content-Type": "text/xml",
      });

    const response = await client().request({
      url: "/jurisprudenciaweb/faces/page/resultado.xhtml",
      method: "POST",
      phase: "detail",
      body: "detalle=1",
      expectedAjaxUpdate: 'id="panel"',
    });

    expect(response.data).toContain("panel");
    expect(response.attempts).toBe(2);
    expect(nock.isDone()).toBe(true);
  });

  it("clasifica como transitorio un 500 que agota los reintentos", async () => {
    const scope = nock(origin).get(pathName).twice().reply(500, "backend no disponible");

    await expect(
      client(new ImmediateClock(), { maxRetries: 1 }).request({
        url: pathName,
        phase: "discover",
      }),
    ).rejects.toMatchObject({
      classification: "http_transient",
      retryable: true,
      status: 500,
      attempt: 2,
    });
    expect(scope.isDone()).toBe(true);
  });

  it("no emite una segunda descarga durante el cooldown global", async () => {
    const clock = new ControlledClock();
    let requests = 0;
    nock(origin)
      .get(pdfPath)
      .reply(() => {
        requests += 1;
        return [429, "límite", { "Retry-After": "2" }];
      })
      .get(pdfPath)
      .twice()
      .reply(() => {
        requests += 1;
        return [200, "%PDF"];
      });
    const http = client(clock, { maxRetries: 1 });
    const first = http.request({ url: pdfPath, phase: "download", kind: "pdf" });
    while (clock.pendingCount === 0) await flush();
    const second = http.request({ url: pdfPath, phase: "download", kind: "pdf" });
    await flush();

    expect(requests).toBe(1);
    clock.advanceBy(2000);
    await Promise.allSettled([first, second]);
    expect(requests).toBe(3);
  });

  it("no reintenta un 404", async () => {
    const scope = nock(origin).get(pathName).once().reply(404, "no existe");
    await expect(client().request({ url: pathName, phase: "discover" })).rejects.toMatchObject({
      classification: "http_permanent",
      attempt: 1,
    });
    expect(scope.isDone()).toBe(true);
  });

  it("reintenta un timeout de transporte y luego continúa", async () => {
    const timeout = new Error("socket timeout");
    Object.assign(timeout, { code: "ETIMEDOUT" });
    nock(origin).get(pathName).replyWithError(timeout).get(pathName).reply(200, "ok");
    const response = await client().request({ url: pathName, phase: "discover" });
    expect(response.data).toBe("ok");
    expect(response.attempts).toBe(2);
  });

  it("agota un documento limitado y permite procesar el siguiente", async () => {
    const clock = new ImmediateClock();
    nock(origin)
      .get("/jurisprudenciaweb/ServletDescarga?uuid=primero")
      .reply(429, "límite", { "Retry-After": "1" })
      .get("/jurisprudenciaweb/ServletDescarga?uuid=segundo")
      .reply(200, "%PDF segundo");
    const http = client(clock, { maxRetries: 0 });
    await expect(
      http.request({
        url: "/jurisprudenciaweb/ServletDescarga?uuid=primero",
        phase: "download",
        kind: "pdf",
      }),
    ).rejects.toMatchObject({ classification: "rate_limit", retryAfterMs: 1000 });
    const second = await http.request({
      url: "/jurisprudenciaweb/ServletDescarga?uuid=segundo",
      phase: "download",
      kind: "pdf",
    });
    expect(Buffer.from(second.data as Uint8Array).toString()).toBe("%PDF segundo");
    expect(clock.sleeps.filter((delay) => delay > 0)).toEqual([1000]);
  });

  it("valida y sigue únicamente el redirect HTTP a HTTPS permitido", async () => {
    nock(origin)
      .get(pathName)
      .reply(302, undefined, {
        Location: "http://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml",
      })
      .get("/jurisprudenciaweb/faces/page/resultado.xhtml")
      .reply(200, "ok");
    const response = await client().request({ url: pathName, phase: "discover" });
    expect(response.data).toBe("ok");
  });

  it("rechaza inmediatamente un redirect externo", async () => {
    nock(origin).get(pathName).reply(302, undefined, {
      Location: "https://example.com/jurisprudenciaweb/x",
    });
    await expect(client().request({ url: pathName, phase: "discover" })).rejects.toMatchObject({
      classification: "security",
      retryable: false,
    });
  });

  it("rebootstrappea estado AJAX sin reutilizar el ViewState inválido", async () => {
    let viewState = "inválido";
    const sentStates: string[] = [];
    nock(origin)
      .post("/jurisprudenciaweb/faces/page/resultado.xhtml")
      .twice()
      .reply((_uri, body) => {
        const rawState =
          typeof body === "string"
            ? new URLSearchParams(body).get("javax.faces.ViewState")
            : typeof body === "object"
              ? (body as Record<string, unknown>)["javax.faces.ViewState"]
              : undefined;
        const state = typeof rawState === "string" ? rawState : "";
        sentStates.push(state);
        return state === "inválido"
          ? [500, "", { "Content-Type": "text/xml" }]
          : [
              200,
              '<partial-response><update id="panel">ok</update></partial-response>',
              { "Content-Type": "text/xml" },
            ];
      });
    const response = await client().requestStateful({
      buildRequest: () => ({
        url: "/jurisprudenciaweb/faces/page/resultado.xhtml",
        method: "POST",
        phase: "discover",
        body: new URLSearchParams({ "javax.faces.ViewState": viewState }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        expectedAjaxUpdate: 'id="panel"',
      }),
      rebootstrap: async () => {
        viewState = "fresco";
        await Promise.resolve();
      },
    });
    expect(response.data).toContain("panel");
    expect(sentStates).toEqual(["inválido", "fresco"]);
  });

  it("no interpreta un XML 200 incompleto como página vacía", async () => {
    nock(origin)
      .post("/jurisprudenciaweb/faces/page/resultado.xhtml")
      .reply(200, "<partial-response></partial-response>", { "Content-Type": "text/xml" });
    await expect(
      client().request({
        url: "/jurisprudenciaweb/faces/page/resultado.xhtml",
        method: "POST",
        phase: "discover",
        expectedAjaxUpdate: 'id="panel"',
      }),
    ).rejects.toMatchObject({ classification: "structural", requiresRebootstrap: true });
  });

  it("aborta respuestas que exceden el límite de contenido", async () => {
    nock(origin).get(pathName).reply(200, "contenido demasiado grande");
    await expect(
      client(new ImmediateClock(), { maxHtmlBytes: 4 }).request({
        url: pathName,
        phase: "discover",
      }),
    ).rejects.toMatchObject({ classification: "invalid_content", retryable: false });
  });

  it("clasifica el preflight 403 con salida accionable sin exigir VPN", async () => {
    nock(origin).get(pathName).reply(403, "forbidden");
    await expect(client().preflight()).rejects.toMatchObject<Partial<PreflightError>>({
      kind: "access",
      exitCode: 3,
      safePath: pathName,
    });
    await expect(
      Promise.reject(new PreflightError("access", "directa o por VPN", pathName)),
    ).rejects.not.toThrow(/VPN obligatoria/i);
  });

  it.each([
    ["ENOTFOUND", "dns", 3],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls", 3],
    ["ETIMEDOUT", "timeout", 3],
    ["ECONNREFUSED", "network", 3],
  ] as const)("distingue preflight %s como %s", async (code, kind, exitCode) => {
    const instance = axios.create({
      adapter: (requestConfig) =>
        Promise.reject(new AxiosError("fallo controlado", code, requestConfig)),
    });
    const http = new PjHttpClient(config({ maxRetries: 0 }), {
      axiosInstance: instance,
      clock: new ImmediateClock(),
      logger: createLogger({ runId: "preflight", level: "silent" }),
    });
    await expect(http.preflight()).rejects.toMatchObject({ kind, exitCode });
  });

  it("clasifica un redirect inesperado durante preflight", async () => {
    nock(origin).get(pathName).reply(302, undefined, {
      Location: "https://example.com/jurisprudenciaweb/x",
    });
    await expect(client().preflight()).rejects.toMatchObject({ kind: "redirect", exitCode: 3 });
  });

  it("registra intentos sin body, cookies, query ni ViewState", async () => {
    let logs = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        logs += String(chunk);
        callback();
      },
    });
    nock(origin)
      .post("/jurisprudenciaweb/faces/page/resultado.xhtml")
      .query({ token: "secreto" })
      .reply(200, "ok");
    const http = client(new ImmediateClock(), {}, destination);
    await http.jar.setCookie("JSESSIONID=real", origin);
    await http.request({
      url: "/jurisprudenciaweb/faces/page/resultado.xhtml?token=secreto",
      method: "POST",
      phase: "detail",
      body: "javax.faces.ViewState=VIEWSTATE_COMPLETO",
      documentId: "doc-1",
      page: 2,
    });
    expect(logs).toContain('"event":"http_attempt"');
    expect(logs).toContain('"safePath":"/jurisprudenciaweb/faces/page/resultado.xhtml"');
    expect(logs).not.toContain("VIEWSTATE_COMPLETO");
    expect(logs).not.toContain("JSESSIONID=real");
    expect(logs).not.toContain("token=secreto");
  });
});
