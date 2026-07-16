import type { Logger } from "pino";

export type HttpPhase = "preflight" | "discover" | "detail" | "download";

export interface RequestMetric {
  phase: HttpPhase;
  method: string;
  safePath: string;
  attempt: number;
  durationMs: number;
  status?: number | undefined;
  code?: string | undefined;
  delayMs?: number | undefined;
  cause?: string | undefined;
  page?: number | undefined;
  documentId?: string | undefined;
}

export class RequestMetrics {
  #rateLimitResponses = 0;

  public constructor(private readonly logger: Logger) {}

  public record(metric: RequestMetric): void {
    if (metric.status === 429 && metric.delayMs === undefined) this.#rateLimitResponses += 1;
    this.logger.info({ event: "http_attempt", ...metric }, "intento HTTP");
  }

  public snapshot(): { rateLimitResponses: number } {
    return { rateLimitResponses: this.#rateLimitResponses };
  }
}
