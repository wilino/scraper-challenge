import { describe, expect, it } from "vitest";

import { HttpRequestError } from "../../src/core/http-errors.js";
import { RedirectPolicy } from "../../src/core/redirect-policy.js";

const origin = "https://jurisprudencia.pj.gob.pe";

describe("política SSRF y redirects", () => {
  const policy = new RedirectPolicy(origin);

  it("acepta el upgrade HTTP a HTTPS observado sin alterar host, puerto ni ruta", () => {
    const result = policy.resolveRedirect(
      new URL(`${origin}/jurisprudenciaweb/faces/page/inicio.xhtml`),
      "http://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml?q=1",
    );
    expect(result.toString()).toBe(
      "https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml?q=1",
    );
  });

  it.each([
    "https://example.com/jurisprudenciaweb/x",
    "http://jurisprudencia.pj.gob.pe:8080/jurisprudenciaweb/x",
    "http://127.0.0.1/jurisprudenciaweb/x",
    "http://192.168.1.2/jurisprudenciaweb/x",
    "file:///jurisprudenciaweb/x",
    "data:text/plain,/jurisprudenciaweb/x",
    "https://jurisprudencia.pj.gob.pe/otra-ruta/x",
    "https://usuario:clave@jurisprudencia.pj.gob.pe/jurisprudenciaweb/x",
  ])("rechaza %s", (target) => {
    expect(() =>
      policy.resolveRedirect(
        new URL(`${origin}/jurisprudenciaweb/faces/page/inicio.xhtml`),
        target,
      ),
    ).toThrow(HttpRequestError);
  });
});
