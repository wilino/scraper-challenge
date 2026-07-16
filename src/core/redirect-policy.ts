import { isIP } from "node:net";

import { HttpRequestError } from "./http-errors.js";

const PJ_PATH_PREFIX = "/jurisprudenciaweb/";

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return false;
  const [first = -1, second = -1] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first === 0
  );
}

function isForbiddenHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (isPrivateIpv4(normalized)) return true;
  if (isIP(normalized) === 6) {
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    );
  }
  return false;
}

function securityError(safePath: string, reason: string): HttpRequestError {
  return new HttpRequestError(`URL o redirect bloqueado: ${reason}`, {
    classification: "security",
    retryable: false,
    safePath,
    attempt: 1,
    code: "ERR_UNSAFE_REDIRECT",
  });
}

export class RedirectPolicy {
  private readonly origin: URL;

  public constructor(allowedOrigin: string) {
    this.origin = new URL(allowedOrigin);
    if (
      this.origin.protocol !== "https:" ||
      this.origin.username !== "" ||
      this.origin.password !== ""
    ) {
      throw new Error("el origen permitido debe ser HTTPS y no contener credenciales");
    }
  }

  public validateRequest(input: string | URL): URL {
    const url = input instanceof URL ? new URL(input) : new URL(input, this.origin);
    this.assertCommonSafety(url);
    if (url.protocol !== "https:" || url.origin !== this.origin.origin) {
      throw securityError(url.pathname || "/", "origen no permitido");
    }
    return url;
  }

  public resolveRedirect(current: URL, location: string): URL {
    let target: URL;
    try {
      target = new URL(location, current);
    } catch {
      throw securityError(current.pathname, "Location inválido");
    }
    this.assertCommonSafety(target);
    if (target.protocol === "http:") {
      if (
        target.hostname !== this.origin.hostname ||
        target.port !== "" ||
        this.origin.port !== ""
      ) {
        throw securityError(target.pathname, "upgrade HTTP fuera del host o puerto permitido");
      }
      target.protocol = "https:";
    }
    if (target.protocol !== "https:" || target.origin !== this.origin.origin) {
      throw securityError(target.pathname, "cambio de origen no permitido");
    }
    return target;
  }

  private assertCommonSafety(url: URL): void {
    if (url.username !== "" || url.password !== "") {
      throw securityError(url.pathname || "/", "userinfo no permitido");
    }
    if (url.protocol === "file:" || url.protocol === "data:") {
      throw securityError(url.pathname || "/", `esquema ${url.protocol} no permitido`);
    }
    if (isForbiddenHost(url.hostname)) {
      throw securityError(url.pathname || "/", "host local o privado no permitido");
    }
    if (!url.pathname.startsWith(PJ_PATH_PREFIX)) {
      throw securityError(url.pathname || "/", "ruta fuera de /jurisprudenciaweb/");
    }
  }
}
