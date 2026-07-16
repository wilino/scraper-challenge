export interface Clock {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

function signalError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("operación abortada");
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: async (milliseconds, signal) => {
    if (milliseconds <= 0) return;
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signalError(signal));
        return;
      }
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error === undefined) resolve();
        else reject(error);
      };
      const abort = () => {
        settle(signalError(signal));
      };
      const timer = setTimeout(() => {
        settle();
      }, milliseconds);
      signal?.addEventListener("abort", abort, { once: true });
    });
  },
};

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
  settled: boolean;
}

export interface HostCooldown {
  pauseFor(milliseconds: number): void;
  wait(signal?: AbortSignal): Promise<void>;
  readonly pausedUntil: number;
}

export class SharedHostCooldown implements HostCooldown {
  private until = 0;

  public constructor(private readonly clock: Clock = systemClock) {}

  public get pausedUntil(): number {
    return this.until;
  }

  public pauseFor(milliseconds: number): void {
    this.until = Math.max(this.until, this.clock.now() + Math.max(0, milliseconds));
  }

  public async wait(signal?: AbortSignal): Promise<void> {
    while (this.until > this.clock.now()) {
      await this.clock.sleep(this.until - this.clock.now(), signal);
    }
  }
}

export interface RateLimiterOptions {
  concurrency: number;
  minDelayMs: number;
  maxDelayMs: number;
  cooldown: HostCooldown;
  clock?: Clock;
  random?: () => number;
}

export class RateLimiter {
  private readonly clock: Clock;
  private readonly random: () => number;
  private active = 0;
  private nextStartAt: number;
  private readonly queue: Waiter[] = [];

  public constructor(private readonly options: RateLimiterOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error("concurrency debe ser un entero positivo");
    }
    if (options.minDelayMs < 0 || options.maxDelayMs < options.minDelayMs) {
      throw new Error("rango de delay inválido");
    }
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    this.nextStartAt = this.clock.now() + this.randomDelay();
  }

  public async schedule<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      await this.options.cooldown.wait(signal);
      const wait = Math.max(0, this.nextStartAt - this.clock.now());
      await this.clock.sleep(wait, signal);
      this.nextStartAt = this.clock.now() + this.randomDelay();
      return await operation();
    } finally {
      release();
    }
  }

  private randomDelay(): number {
    const range = this.options.maxDelayMs - this.options.minDelayMs;
    return this.options.minDelayMs + Math.floor(this.random() * (range + 1));
  }

  private async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) throw signalError(signal);
    if (this.active < this.options.concurrency && this.queue.length === 0) {
      this.active += 1;
      return this.createRelease();
    }
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, settled: false };
      if (signal !== undefined) waiter.signal = signal;
      const abort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        this.rejectWaiter(waiter, signalError(signal));
      };
      waiter.abort = abort;
      this.queue.push(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.options.concurrency && this.queue.length > 0) {
      const waiter = this.queue.shift();
      if (waiter === undefined) return;
      if (waiter.signal?.aborted === true) {
        this.rejectWaiter(waiter, signalError(waiter.signal));
        continue;
      }
      this.settleWaiter(waiter);
      this.active += 1;
      waiter.resolve(this.createRelease());
    }
  }

  private settleWaiter(waiter: Waiter): boolean {
    if (waiter.settled) return false;
    waiter.settled = true;
    if (waiter.abort !== undefined) waiter.signal?.removeEventListener("abort", waiter.abort);
    return true;
  }

  private rejectWaiter(waiter: Waiter, reason: unknown): void {
    if (this.settleWaiter(waiter)) waiter.reject(reason);
  }
}
