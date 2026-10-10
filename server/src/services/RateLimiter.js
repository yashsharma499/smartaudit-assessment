/**
 * Minimal client-side rate limiter: spaces calls so at most `maxPerMinute` start per minute.
 * Calls are serialised through a promise chain, so concurrent workers queue fairly.
 * (In production this would be a shared limiter, e.g. Redis, so it holds across instances.)
 */
export class RateLimiter {
  constructor(maxPerMinute) {
    this.intervalMs = maxPerMinute > 0 ? Math.ceil(60000 / maxPerMinute) : 0;
    this.nextSlot = 0;
    this.chain = Promise.resolve();
  }

  acquire() {
    if (this.intervalMs === 0) return Promise.resolve();
    const turn = this.chain.then(async () => {
      const wait = this.nextSlot - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.nextSlot = Math.max(Date.now(), this.nextSlot) + this.intervalMs;
    });
    this.chain = turn.catch(() => {});
    return turn;
  }
}
