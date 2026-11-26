// Hedged / failover streaming. Dependency-free so it can be unit-tested without a network.
//
// Race rule: start candidate 0. If it fails, start the next immediately. If it has produced no
// first token after `hedgeAfterMs`, start the next one concurrently. The first attempt to emit a
// token wins; every other attempt is aborted (so we stop paying for it).
// Once tokens have been sent to the client we cannot fail over: a mid-stream failure is surfaced.
const HEDGE = Symbol('hedge');
const IDLE = Symbol('idle');

const timer = (ms, value) => {
  let t;
  const promise = new Promise((r) => { t = setTimeout(() => r(value), ms); });
  return { promise, cancel: () => clearTimeout(t) };
};
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError', code: 'aborted' });
const unavailable = () => Object.assign(new Error('all_providers_unavailable'), { code: 'all_providers_unavailable' });

export async function* hedgedStream({
  candidates, start, signal,
  hedgeAfterMs = 2500, idleMs = 20_000,
  allow = () => true, report = () => {}, isRetryable = () => true,
}) {
  const t0 = Date.now();
  const attempts = [];
  let next = 0;
  let lastErr = null;

  const launch = () => {
    while (next < candidates.length) {
      const cand = candidates[next++];
      if (!allow(cand)) continue; // breaker open: skip
      const a = { cand, ctrl: new AbortController(), done: false, abandoned: false };
      signal?.addEventListener('abort', () => a.ctrl.abort(), { once: true });
      a.settled = (async () => {
        const it = await start(cand, a.ctrl.signal);
        const first = await it.next();
        return { it, first };
      })().then(
        (r) => {
          if (a.abandoned) r.it.return?.()?.catch?.(() => {}); // lost the race after connecting: clean up
          return { a, r };
        },
        (err) => ({ a, err }),
      );
      attempts.push(a);
      return a;
    }
    return null;
  };

  const abandon = (except) => {
    for (const a of attempts) {
      if (a !== except && !a.done) {
        a.done = true;
        a.abandoned = true;
        a.ctrl.abort();
        report(a.cand, 'abort');
      }
    }
  };

  if (signal?.aborted) throw abortError();
  if (!launch()) throw unavailable();

  let winner, it, first;
  for (;;) {
    if (signal?.aborted) { abandon(); throw abortError(); }
    const live = attempts.filter((a) => !a.done);
    if (!live.length) {
      if (!launch()) throw lastErr ?? unavailable();
      continue;
    }
    const hedge = next < candidates.length ? timer(hedgeAfterMs, HEDGE) : null;
    const ev = await Promise.race([...live.map((a) => a.settled), ...(hedge ? [hedge.promise] : [])]);
    hedge?.cancel();

    if (ev === HEDGE) { launch(); continue; }
    if (ev.err) {
      ev.a.done = true;
      if (signal?.aborted) { report(ev.a.cand, 'abort'); continue; }
      report(ev.a.cand, 'failure', ev.err);
      lastErr = ev.err;
      if (!isRetryable(ev.err)) { abandon(); throw ev.err; }
      continue;
    }
    winner = ev.a;
    ({ it, first } = ev.r);
    break;
  }

  abandon(winner);
  yield { type: 'start', candidate: winner.cand, hedged: attempts.length > 1, ttftMs: Date.now() - t0 };

  let outcome = null;
  try {
    let step = first;
    while (!step.done) {
      yield { type: 'chunk', value: step.value };
      const idle = timer(idleMs, IDLE);
      const res = await Promise.race([it.next(), idle.promise]);
      idle.cancel();
      if (res === IDLE) {
        winner.ctrl.abort();
        throw Object.assign(new Error('upstream_idle_timeout'), { code: 'idle_timeout' });
      }
      step = res;
    }
    outcome = ['success'];
  } catch (err) {
    outcome = signal?.aborted ? ['abort'] : ['failure', err];
    throw err;
  } finally {
    outcome ??= ['abort']; // consumer stopped early (client disconnect)
    report(winner.cand, ...outcome);
    winner.ctrl.abort();
    it.return?.()?.catch?.(() => {});
  }
}
