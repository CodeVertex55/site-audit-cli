import { describe, expect, test } from "vitest";
import { HostGate, parseRetryAfter, type Clock } from "../src/crawl/ratelimit.js";

function fakeClock(): Clock {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("HostGate", () => {
  test("spaces request starts by the delay", async () => {
    const clock = fakeClock();
    const gate = new HostGate({ delayMs: 1000, concurrency: 2, clock });
    const starts: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const release = await gate.acquire("h");
      starts.push(clock.now());
      release();
    }
    expect(starts).toEqual([0, 1000, 2000]);
  });

  test("with concurrency 2 the third acquire waits for a release", async () => {
    const clock = fakeClock();
    const gate = new HostGate({ delayMs: 1000, concurrency: 2, clock });
    const first = await gate.acquire("h");
    const second = await gate.acquire("h");
    expect(clock.now()).toBe(1000);
    let thirdStarted = false;
    const third = gate.acquire("h").then((release) => {
      thirdStarted = true;
      return release;
    });
    await flush();
    expect(thirdStarted).toBe(false);
    first();
    const release = await third;
    expect(clock.now()).toBe(2000);
    release();
    second();
  });

  test("different hosts do not wait for each other", async () => {
    const clock = fakeClock();
    const gate = new HostGate({ delayMs: 1000, concurrency: 1, clock });
    const a = await gate.acquire("a.example");
    const startA = clock.now();
    const b = await gate.acquire("b.example");
    const startB = clock.now();
    expect([startA, startB]).toEqual([0, 0]);
    a();
    b();
  });

  test("concurrency 1 makes the second acquire wait for the first release", async () => {
    const clock = fakeClock();
    const gate = new HostGate({ delayMs: 0, concurrency: 1, clock });
    const first = await gate.acquire("h");
    let secondStarted = false;
    const second = gate.acquire("h").then((release) => {
      secondStarted = true;
      return release;
    });
    await flush();
    expect(secondStarted).toBe(false);
    first();
    const release = await second;
    expect(secondStarted).toBe(true);
    release();
  });

  test("a release function frees only one slot when called twice", async () => {
    const clock = fakeClock();
    const gate = new HostGate({ delayMs: 0, concurrency: 1, clock });
    const first = await gate.acquire("h");
    first();
    first();
    const second = await gate.acquire("h");
    let thirdStarted = false;
    void gate.acquire("h").then(() => {
      thirdStarted = true;
    });
    await flush();
    expect(thirdStarted).toBe(false);
    second();
  });

  test("setMinDelay raises the delay and never lowers it", () => {
    const gate = new HostGate({ delayMs: 1000, concurrency: 1, clock: fakeClock() });
    expect(gate.delayFor("h")).toBe(1000);
    gate.setMinDelay("h", 500);
    expect(gate.delayFor("h")).toBe(1000);
    gate.setMinDelay("h", 4000);
    expect(gate.delayFor("h")).toBe(4000);
    expect(gate.delayFor("other")).toBe(1000);
  });

  test("doubleDelay doubles the delay for that host only", () => {
    const gate = new HostGate({ delayMs: 1000, concurrency: 1, clock: fakeClock() });
    gate.doubleDelay("h");
    expect(gate.delayFor("h")).toBe(2000);
    gate.doubleDelay("h");
    expect(gate.delayFor("h")).toBe(4000);
    expect(gate.delayFor("other")).toBe(1000);
  });

  test("a raised delay applies to the next acquire", async () => {
    const clock = fakeClock();
    const gate = new HostGate({ delayMs: 1000, concurrency: 1, clock });
    (await gate.acquire("h"))();
    gate.doubleDelay("h");
    const release = await gate.acquire("h");
    expect(clock.now()).toBe(2000);
    release();
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");

  test("reads whole seconds", () => {
    expect(parseRetryAfter("3", now)).toBe(3000);
    expect(parseRetryAfter("0", now)).toBe(0);
  });

  test("defaults to 5000 when missing", () => {
    expect(parseRetryAfter(null, now)).toBe(5000);
  });

  test("caps at 60000", () => {
    expect(parseRetryAfter("999", now)).toBe(60000);
  });

  test("reads an HTTP date", () => {
    const later = new Date(now + 10_000).toUTCString();
    const ms = parseRetryAfter(later, now);
    expect(ms).toBeGreaterThanOrEqual(9000);
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  test("a date in the past gives 0, never negative", () => {
    const earlier = new Date(now - 30_000).toUTCString();
    expect(parseRetryAfter(earlier, now)).toBe(0);
  });

  test("garbage gives 5000", () => {
    expect(parseRetryAfter("soon", now)).toBe(5000);
    expect(parseRetryAfter("", now)).toBe(5000);
    expect(parseRetryAfter("-5", now)).toBe(5000);
  });
});
