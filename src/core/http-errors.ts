export type HttpErrorClassification =
  | "access"
  | "network"
  | "timeout"
  | "rate_limit"
  | "http_transient"
  | "http_permanent"
  | "session_invalid"
  | "structural"
  | "security"
  | "invalid_content"
  | "interrupted";

export interface HttpRequestErrorDetails {
  classification: HttpErrorClassification;
  retryable: boolean;
  safePath: string;
  attempt: number;
  status?: number;
  code?: string;
  retryAfterMs?: number;
  requiresRebootstrap?: boolean;
  cause?: unknown;
}

export class HttpRequestError extends Error {
  public readonly classification: HttpErrorClassification;
  public readonly retryable: boolean;
  public readonly safePath: string;
  public readonly attempt: number;
  public readonly status?: number;
  public readonly code?: string;
  public readonly retryAfterMs?: number;
  public readonly requiresRebootstrap: boolean;

  public constructor(message: string, details: HttpRequestErrorDetails) {
    super(message, { cause: details.cause });
    this.name = "HttpRequestError";
    this.classification = details.classification;
    this.retryable = details.retryable;
    this.safePath = details.safePath;
    this.attempt = details.attempt;
    this.requiresRebootstrap = details.requiresRebootstrap ?? false;
    if (details.status !== undefined) this.status = details.status;
    if (details.code !== undefined) this.code = details.code;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
  }
}

export type PreflightFailureKind = "access" | "dns" | "tls" | "timeout" | "redirect" | "network";

const PREFLIGHT_EXIT_CODES: Readonly<Record<PreflightFailureKind, number>> = {
  access: 3,
  dns: 3,
  tls: 3,
  timeout: 3,
  redirect: 3,
  network: 3,
};

export class PreflightError extends Error {
  public readonly kind: PreflightFailureKind;
  public readonly exitCode: number;
  public readonly safePath: string;
  public readonly code?: string;

  public constructor(kind: PreflightFailureKind, message: string, safePath: string, code?: string) {
    super(message);
    this.name = "PreflightError";
    this.kind = kind;
    this.exitCode = PREFLIGHT_EXIT_CODES[kind];
    this.safePath = safePath;
    if (code !== undefined) this.code = code;
  }
}
