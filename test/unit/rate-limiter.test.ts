import { getEventListeners } from "node:events";

import { describe, expect, it } from "vitest";

import { RateLimiter, systemClock, type HostCooldown } from "../../src/core/rate-limiter.js";

const idleCooldown: HostCooldown = {
  pausedUntil: 0,
  pauseFor: () => undefined,
  wait: () => Promise.resolve(),
};

describe("cleanup de AbortSignal", () => {
  it("rechaza configuraciones de pacing inválidas", () => {
    expect(
      () =>
        new RateLimiter({
          concurrency: 1,
          minDelayMs: 2,
          maxDelayMs: 1,
          cooldown: idleCooldown,
        }),
    ).toThrow("rango de delay inválido");
  });

  it("systemClock.sleep no acumula listeners al resolver", async () => {
    const controller = new AbortController();
    for (let index = 0; index < 100; index += 1) {
      await systemClock.sleep(1, controller.signal);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    }
  });

  it("libera listeners tanto al entregar slots como al abortar la cola", async () => {
    const limiter = new RateLimiter({
      concurrency: 1,
      minDelayMs: 0,
      maxDelayMs: 0,
      cooldown: idleCooldown,
      random: () => 0,
    });
    const controller = new AbortController();
    let releaseFirst: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = limiter.schedule(async () => {
      markStarted?.();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    await started;

    const queued = Array.from({ length: 5 }, () =>
      limiter.schedule(() => Promise.resolve(), controller.signal),
    );
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(5);
    releaseFirst?.();
    await first;
    await Promise.all(queued);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    const blockerStarted = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    const blocker = limiter.schedule(async () => {
      markStarted?.();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    await blockerStarted;
    const aborted = limiter.schedule(() => Promise.resolve(), controller.signal);
    controller.abort(new Error("cancelado"));
    await expect(aborted).rejects.toThrow("cancelado");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    releaseFirst?.();
    await blocker;
  });
});
