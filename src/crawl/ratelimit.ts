export type Clock = { now(): number; sleep(ms: number): Promise<void> };

export const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    }),
};

type HostState = {
  /** Chain that keeps acquirers in arrival order. */
  tail: Promise<void>;
  inFlight: number;
  lastStart: number | null;
  delayMs: number;
  doubled: boolean;
  slotWaiters: (() => void)[];
};

/**
 * Per-host request gate. A request may start when fewer than `concurrency`
 * requests to the host are in flight and at least the host's delay has passed
 * since the previous request started. Hosts do not wait for each other.
 */
export class HostGate {
  private readonly hosts = new Map<string, HostState>();
  private readonly baseDelayMs: number;
  private readonly concurrency: number;
  private readonly clock: Clock;

  constructor(opts: { delayMs: number; concurrency: number; clock?: Clock }) {
    this.baseDelayMs = Math.max(0, opts.delayMs);
    this.concurrency = Math.max(1, Math.floor(opts.concurrency));
    this.clock = opts.clock ?? realClock;
  }

  private stateFor(host: string): HostState {
    let state = this.hosts.get(host);
    if (state === undefined) {
      state = {
        tail: Promise.resolve(),
        inFlight: 0,
        lastStart: null,
        delayMs: this.baseDelayMs,
        doubled: false,
        slotWaiters: [],
      };
      this.hosts.set(host, state);
    }
    return state;
  }

  /** Resolves when a slot is free and the host's delay has passed. Returns a release function. */
  async acquire(host: string): Promise<() => void> {
    const state = this.stateFor(host);
    const turn = state.tail;
    let finish: () => void = () => undefined;
    state.tail = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await turn;
    try {
      while (state.inFlight >= this.concurrency) {
        await new Promise<void>((resolve) => {
          state.slotWaiters.push(resolve);
        });
      }
      if (state.lastStart !== null) {
        let wait = state.lastStart + state.delayMs - this.clock.now();
        while (wait > 0) {
          await this.clock.sleep(wait);
          wait = state.lastStart + state.delayMs - this.clock.now();
        }
      }
      state.lastStart = this.clock.now();
      state.inFlight += 1;
    } finally {
      finish();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.inFlight -= 1;
      state.slotWaiters.shift()?.();
    };
  }

  /** Raises the host's delay to at least `ms`. Never lowers it. */
  setMinDelay(host: string, ms: number): void {
    const state = this.stateFor(host);
    state.delayMs = Math.max(state.delayMs, ms);
  }

  /**
   * Doubles the host's delay, at most once per host. Returns true on the first
   * call for a host and false afterwards. A delay of 0 becomes 1000 ms.
   */
  doubleDelay(host: string): boolean {
    const state = this.stateFor(host);
    if (state.doubled) return false;
    state.doubled = true;
    state.delayMs = state.delayMs === 0 ? 1000 : state.delayMs * 2;
    return true;
  }

  delayFor(host: string): number {
    return this.hosts.get(host)?.delayMs ?? this.baseDelayMs;
  }
}

const RETRY_AFTER_DEFAULT_MS = 5000;
const RETRY_AFTER_CAP_MS = 60_000;

function isDigits(text: string): boolean {
  if (text === "") return false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function hasLetter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i) | 32;
    if (code >= 97 && code <= 122) return true;
  }
  return false;
}

/**
 * Parses a Retry-After header (seconds or HTTP date) into milliseconds.
 * Missing or unparseable values give 5000. The result is capped at 60000 and
 * is never negative.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number {
  if (value === null) return RETRY_AFTER_DEFAULT_MS;
  const text = value.trim();
  if (isDigits(text)) return Math.min(Number(text) * 1000, RETRY_AFTER_CAP_MS);
  if (!hasLetter(text)) return RETRY_AFTER_DEFAULT_MS;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return RETRY_AFTER_DEFAULT_MS;
  return Math.min(Math.max(at - nowMs, 0), RETRY_AFTER_CAP_MS);
}
