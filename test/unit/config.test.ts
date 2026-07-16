import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "../../src/config/env.js";

describe("configuración", () => {
  it("carga defaults válidos y crea el directorio de salida", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pj-config-"));
    const config = loadConfig({}, cwd);
    expect(config.baseUrl).toBe("https://jurisprudencia.pj.gob.pe");
    expect(config.startPath).toContain("inicio.xhtml");
    expect(config.outputDir).toBe(path.join(cwd, "output"));
    expect(config.connectTimeoutMs).toBe(15_000);
    expect(config.requestTimeoutMs).toBe(120_000);
    expect(config.pdfTimeoutMs).toBe(120_000);
  });

  it("permite configurar por separado los timeouts de conexión, HTML y PDF", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pj-config-"));
    const config = loadConfig(
      {
        CONNECT_TIMEOUT_MS: "10000",
        REQUEST_TIMEOUT_MS: "121000",
        PDF_TIMEOUT_MS: "122000",
      },
      cwd,
    );

    expect(config.connectTimeoutMs).toBe(10_000);
    expect(config.requestTimeoutMs).toBe(121_000);
    expect(config.pdfTimeoutMs).toBe(122_000);
  });

  it("falla con un mensaje accionable cuando el delay mínimo supera el máximo", () => {
    expect(() => loadConfig({ MIN_REQUEST_DELAY_MS: "10", MAX_REQUEST_DELAY_MS: "5" })).toThrow(
      /MIN_REQUEST_DELAY_MS.*menor o igual/,
    );
  });

  it("rechaza resultado.xhtml como bootstrap", () => {
    expect(() =>
      loadConfig({ SCRAPER_START_PATH: "/jurisprudenciaweb/faces/page/resultado.xhtml" }),
    ).toThrow(/no es un bootstrap válido/);
  });

  it("rechaza un origen no permitido", () => {
    expect(() => loadConfig({ SCRAPER_BASE_URL: "https://example.com" })).toThrow(
      /origen no permitido/,
    );
  });

  it("rechaza una ruta de salida que es un archivo", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pj-config-"));
    writeFileSync(path.join(cwd, "archivo"), "x");
    expect(() => loadConfig({ OUTPUT_DIR: "archivo" }, cwd)).toThrow(ConfigurationError);
  });
});
