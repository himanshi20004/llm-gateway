export class CircuitBreaker {
  constructor({ threshold = 5, windowMs = 30_000, openMs = 20_000, now = () => Date.now() } = {}) {
    Object.assign(this, { threshold, windowMs, openMs, now });
    this.state = 'closed';
    this.fails = [];
    this.openedAt = 0;
    this.probing = false;
  }

  allow() {
    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.openMs) return false;
      this.state = 'half';
      this.probing = false;
    }
    if (this.state === 'half') {
      if (this.probing) return false; // exactly one probe at a time
      this.probing = true;
      return true;
    }
    return true;
  }

  success() {
    this.state = 'closed';
    this.fails = [];
    this.probing = false;
  }

  failure() {
    const t = this.now();
    if (this.state === 'half') return this.#trip(t);
    this.fails = this.fails.filter((x) => t - x < this.windowMs);
    this.fails.push(t);
    if (this.fails.length >= this.threshold) this.#trip(t);
  }

  /** A cancelled attempt (hedge loser, client disconnect) says nothing about provider health. */
  abort() {
    if (this.state === 'half') this.probing = false;
  }

  #trip(t) {
    this.state = 'open';
    this.openedAt = t;
    this.probing = false;
    this.fails = [];
  }
}

const registry = new Map();
export const getBreaker = (id) => {
  if (!registry.has(id)) registry.set(id, new CircuitBreaker());
  return registry.get(id);
};

export function report(cand, kind) {
  const b = getBreaker(cand.id);
  if (kind === 'success') b.success();
  else if (kind === 'failure') b.failure();
  else b.abort();
}

/** Network errors, timeouts, 429 and 5xx are retryable. Other 4xx mean our request is bad: fail fast. */
export function isRetryable(err) {
  const status = err?.status ?? err?.response?.status;
  if (!status) return true;
  return [401, 403, 408, 409, 425, 429].includes(status) || status >= 500;
}
