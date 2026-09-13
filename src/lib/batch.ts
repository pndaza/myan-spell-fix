//! Batching helpers for long-document runs (patterns adapted from the
//! ebook-translator job pipeline): an abort-aware sleep, a retry wrapper
//! for transient AI errors, and a bounded-concurrency pool that keeps
//! results in input order. Philosophy: rate limits are EXPECTED on the
//! free tier and must never kill a run — retry with backoff; a unit that
//! still fails is skipped and reported, not fatal; only cancellation and
//! key/access errors stop everything.

/** Resolve after `ms`, or reject with AbortError when `signal` fires
 *  first (a backoff pause must not outlive a cancelled run). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("This operation was aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("This operation was aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RetryOpts {
  /** Total tries, first attempt included. */
  attempts: number;
  /** True to retry this error; anything else rethrows immediately. */
  retryIf: (err: unknown) => boolean;
  /** Backoff before retry #attempt (1-based). */
  delayMs: (attempt: number, err: unknown) => number;
  /** Optional observer for UI status ("rate limited — waiting 8s…"). */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
  signal?: AbortSignal;
}

/** Call `fn`, retrying transient failures per `opts`. Rethrows the last
 *  error when attempts run out or the error is not retryable. */
export async function withRetries<T>(
  fn: () => Promise<T>,
  opts: RetryOpts,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.attempts - 1 || !opts.retryIf(err)) throw err;
      const ms = opts.delayMs(attempt + 1, err);
      opts.onRetry?.(attempt + 1, err, ms);
      await sleep(ms, opts.signal);
    }
  }
}

export interface PoolOutcome<O> {
  /** results[i] corresponds to items[i]; null where that item failed. */
  results: Array<O | null>;
  /** Indices of the failed items, in ascending order. */
  failed: number[];
  /** The most recent per-item error — the real reason to show when
   *  everything failed. */
  lastError: unknown;
}

/** Run `fn` over `items` with at most `limit` calls in flight. Results
 *  keep input order regardless of completion order. A non-fatal error
 *  marks that item failed and the pool moves on to the next; a fatal one
 *  (per `isFatal`; AbortError is always fatal) stops dispatching new work
 *  and rethrows once in-flight calls settle. */
export async function mapPool<I, O>(
  items: I[],
  limit: number,
  fn: (item: I, index: number) => Promise<O>,
  isFatal: (err: unknown) => boolean = () => false,
): Promise<PoolOutcome<O>> {
  const results: Array<O | null> = new Array(items.length).fill(null);
  const failed: number[] = [];
  let lastError: unknown;
  let next = 0;
  let fatal: unknown;
  let fatalFlag = false;

  const workerCount = items.length === 0 ? 0 : Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      if (fatalFlag) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        if ((err instanceof Error && err.name === "AbortError") || isFatal(err)) {
          fatalFlag = true;
          fatal = err;
          return;
        }
        results[i] = null;
        failed.push(i);
        lastError = err;
      }
    }
  });
  await Promise.all(workers);
  if (fatalFlag) throw fatal;
  return { results, failed, lastError };
}
