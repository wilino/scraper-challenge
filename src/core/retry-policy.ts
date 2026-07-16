export interface RetryPolicyOptions {
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  random?: () => number;
  now?: () => number;
}

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
  source: "retry-after" | "backoff" | "none";
}

export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

export class RetryPolicy {
  private readonly random: () => number;
  private readonly now: () => number;

  public constructor(private readonly options: RetryPolicyOptions) {
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  public decide(attempt: number, retryable: boolean, retryAfter?: string): RetryDecision {
    if (!retryable || attempt > this.options.maxRetries) {
      return { retry: false, delayMs: 0, source: "none" };
    }
    const headerDelay = parseRetryAfter(retryAfter, this.now());
    if (headerDelay !== undefined) {
      return { retry: true, delayMs: headerDelay, source: "retry-after" };
    }
    const cap = Math.min(
      this.options.backoffMaxMs,
      this.options.backoffBaseMs * 2 ** Math.max(0, attempt - 1),
    );
    return { retry: true, delayMs: Math.floor(this.random() * (cap + 1)), source: "backoff" };
  }
}
