import { describe, expect, it } from "vitest";

import { parseRetryAfter, RetryPolicy } from "../../src/core/retry-policy.js";

describe("política de reintentos", () => {
  it("interpreta Retry-After en segundos y fecha HTTP", () => {
    const now = Date.parse("2026-07-16T12:00:00.000Z");
    expect(parseRetryAfter("3", now)).toBe(3000);
    expect(parseRetryAfter("Thu, 16 Jul 2026 12:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter("inválido", now)).toBeUndefined();
  });

  it("usa backoff exponencial con full jitter y respeta el máximo", () => {
    const policy = new RetryPolicy({
      maxRetries: 2,
      backoffBaseMs: 100,
      backoffMaxMs: 150,
      random: () => 0.5,
    });
    expect(policy.decide(1, true)).toEqual({ retry: true, delayMs: 50, source: "backoff" });
    expect(policy.decide(2, true)).toEqual({ retry: true, delayMs: 75, source: "backoff" });
    expect(policy.decide(3, true)).toEqual({ retry: false, delayMs: 0, source: "none" });
    expect(policy.decide(1, false)).toEqual({ retry: false, delayMs: 0, source: "none" });
  });
});
