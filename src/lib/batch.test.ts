import { describe, expect, it, vi } from "vitest";
import { mapPool, sleep, withRetries } from "./batch";

describe("sleep", () => {
  it("resolves after the delay", async () => {
    vi.useFakeTimers();
    try {
      const p = sleep(500);
      let done = false;
      p.then(() => (done = true));
      await vi.advanceTimersByTimeAsync(499);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with AbortError when the signal fires mid-sleep", async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const p = sleep(10_000, ac.signal);
      const assertion = expect(p).rejects.toMatchObject({ name: "AbortError" });
      ac.abort();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects immediately when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleep(10, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("withRetries", () => {
  it("succeeds on the first try without delay", async () => {
    let calls = 0;
    const r = await withRetries(
      async () => {
        calls++;
        return "ok";
      },
      { attempts: 3, retryIf: () => true, delayMs: () => 1000 },
    );
    expect(r).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries a transient error until it succeeds", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const p = withRetries(
        async () => {
          calls++;
          if (calls < 3) throw new Error("429");
          return "ok";
        },
        {
          attempts: 5,
          retryIf: (e) => (e as Error).message === "429",
          delayMs: (attempt) => 1000 * attempt,
        },
      );
      const assertion = expect(p).resolves.toBe("ok");
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rethrows immediately on a non-retryable error", async () => {
    let calls = 0;
    await expect(
      withRetries(
        async () => {
          calls++;
          throw new Error("fatal");
        },
        {
          attempts: 5,
          retryIf: (e) => (e as Error).message !== "fatal",
          delayMs: () => 1,
        },
      ),
    ).rejects.toThrow("fatal");
    expect(calls).toBe(1);
  });

  it("throws the last error when attempts run out", async () => {
    let calls = 0;
    const observed: number[] = [];
    await expect(
      withRetries(
        async () => {
          calls++;
          throw new Error(`boom-${calls}`);
        },
        {
          attempts: 3,
          retryIf: () => true,
          delayMs: (attempt) => {
            observed.push(attempt);
            return 1;
          },
        },
      ),
    ).rejects.toThrow("boom-3");
    expect(calls).toBe(3);
    expect(observed).toEqual([1, 2]); // no delay before the final throw
  });

  it("reports retries to onRetry with the computed delay", async () => {
    vi.useFakeTimers();
    try {
      const seen: Array<[number, number]> = [];
      let calls = 0;
      const p = withRetries(
        async () => {
          calls++;
          if (calls === 1) throw new Error("transient");
          return 42;
        },
        {
          attempts: 3,
          retryIf: () => true,
          delayMs: (attempt) => attempt * 1000,
          onRetry: (attempt, _err, ms) => seen.push([attempt, ms]),
        },
      );
      const assertion = expect(p).resolves.toBe(42);
      await vi.advanceTimersByTimeAsync(2000);
      await assertion;
      expect(seen).toEqual([[1, 1000]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an abort during the backoff sleep rejects with AbortError", async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const p = withRetries(
        async () => {
          throw new Error("transient");
        },
        {
          attempts: 5,
          retryIf: () => true,
          delayMs: () => 60_000,
          signal: ac.signal,
        },
      );
      const assertion = expect(p).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(10); // inside the sleep now
      ac.abort();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mapPool", () => {
  it("keeps results in input order regardless of completion order", async () => {
    const delays = [80, 40, 10, 60, 20]; // last item finishes first
    const outcome = await mapPool(
      delays,
      2,
      async (d, i) => {
        await sleep(d);
        return `r${i}`;
      },
    );
    expect(outcome.failed).toEqual([]);
    expect(outcome.results).toEqual(["r0", "r1", "r2", "r3", "r4"]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async (i) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(20 + (i % 3) * 5);
        inFlight--;
        return i;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("records failed indices and keeps the rest", async () => {
    const outcome = await mapPool(
      [0, 1, 2, 3],
      2,
      async (i) => {
        await sleep(5);
        if (i === 1 || i === 3) throw new Error(`boom-${i}`);
        return i * 10;
      },
    );
    expect(outcome.results).toEqual([0, null, 20, null]);
    expect(outcome.failed).toEqual([1, 3]);
    expect((outcome.lastError as Error).message).toBe("boom-3");
  });

  it("a fatal error stops dispatching and rethrows", async () => {
    let started = 0;
    await expect(
      mapPool(
        Array.from({ length: 20 }, (_, i) => i),
        2,
        async (i) => {
          started++;
          await sleep(10);
          if (i === 0) throw new Error("invalid_api_key");
          return i;
        },
        (err) => (err as Error).message === "invalid_api_key",
      ),
    ).rejects.toThrow("invalid_api_key");
    // worker 1 hit the fatal error after one item; worker 2 finished at
    // most one more; the remaining ~18 were never started
    expect(started).toBeLessThanOrEqual(4);
  });

  it("AbortError is always fatal", async () => {
    await expect(
      mapPool(
        [0, 1, 2],
        3,
        async (i) => {
          await sleep(5);
          if (i === 0) throw new DOMException("aborted", "AbortError");
          return i;
        },
        () => false,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("handles empty input", async () => {
    const outcome = await mapPool([], 3, async (x) => x);
    expect(outcome.results).toEqual([]);
    expect(outcome.failed).toEqual([]);
  });
});
