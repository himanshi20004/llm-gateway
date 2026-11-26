import test from 'node:test';
import assert from 'node:assert/strict';
import { hedgedStream } from '../src/core/hedge.js';
import { CircuitBreaker, isRetryable } from '../src/core/breaker.js';
import { heuristicScore, tierFromScore } from '../src/core/classifier.js';
import { localEmbed, cosine, encodeVec, decodeVec } from '../src/core/embeddings.js';
import { newApiKey, parseApiKey, hashSecret, encrypt, decrypt, safeEqual } from '../src/lib/crypto.js';

const sleep = (ms, sig) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  sig?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

function fake(behaviors) {
  const aborted = {};
  const start = async (c, sig) => {
    const b = behaviors[c.id];
    sig.addEventListener('abort', () => { aborted[c.id] = true; });
    return (async function* () {
      await sleep(b.firstMs ?? 1, sig);
      if (b.fail) throw Object.assign(new Error('boom'), { status: b.status ?? 503 });
      for (const t of b.chunks ?? ['a', 'b']) { yield { text: t }; await sleep(b.gapMs ?? 1, sig); }
    })();
  };
  return { start, aborted };
}
async function collect(gen) {
  const out = { text: '', start: null };
  for await (const ev of gen) { if (ev.type === 'start') out.start = ev; else out.text += ev.value.text; }
  return out;
}
const C = (id) => ({ id });

test('failover: a fast failure starts the next candidate without waiting for the hedge timer', async () => {
  const { start } = fake({ A: { fail: true }, B: { chunks: ['x', 'y'] } });
  const t = Date.now();
  const out = await collect(hedgedStream({ candidates: [C('A'), C('B')], start, hedgeAfterMs: 5000, isRetryable }));
  assert.equal(out.text, 'xy');
  assert.equal(out.start.candidate.id, 'B');
  assert.ok(Date.now() - t < 1000);
});

test('hedge: a slow first token triggers a backup, the loser is aborted', async () => {
  const { start, aborted } = fake({ A: { firstMs: 400 }, B: { firstMs: 5, chunks: ['ok'] } });
  const reports = [];
  const out = await collect(hedgedStream({ candidates: [C('A'), C('B')], start, hedgeAfterMs: 30, report: (c, k) => reports.push(`${c.id}:${k}`) }));
  assert.equal(out.start.candidate.id, 'B');
  assert.equal(out.start.hedged, true);
  assert.equal(aborted.A, true);
  assert.ok(reports.includes('A:abort') && reports.includes('B:success'));
});

test('non-retryable error (400) fails fast without trying another provider', async () => {
  const { start } = fake({ A: { fail: true, status: 400 }, B: {} });
  await assert.rejects(collect(hedgedStream({ candidates: [C('A'), C('B')], start, isRetryable })), { status: 400 });
});

test('all providers failing surfaces the last error', async () => {
  const { start } = fake({ A: { fail: true }, B: { fail: true } });
  await assert.rejects(collect(hedgedStream({ candidates: [C('A'), C('B')], start, isRetryable })), { message: 'boom' });
});

test('idle timeout mid-stream raises and reports a failure', async () => {
  const { start } = fake({ A: { chunks: ['a', 'b'], gapMs: 500 } });
  const reports = [];
  await assert.rejects(
    collect(hedgedStream({ candidates: [C('A')], start, idleMs: 50, report: (c, k) => reports.push(k) })),
    { code: 'idle_timeout' },
  );
  assert.deepEqual(reports, ['failure']);
});

test('client abort cancels in-flight attempts and throws', async () => {
  const { start, aborted } = fake({ A: { firstMs: 500 } });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(collect(hedgedStream({ candidates: [C('A')], start, signal: ac.signal })), { name: 'AbortError' });
  assert.equal(aborted.A, true);
});

test('open breakers are skipped', async () => {
  const { start } = fake({ A: {}, B: { chunks: ['b'] } });
  const out = await collect(hedgedStream({ candidates: [C('A'), C('B')], start, allow: (c) => c.id !== 'A' }));
  assert.equal(out.start.candidate.id, 'B');
});

test('breaker: opens, half-opens with a single probe, closes on success', () => {
  let now = 0;
  const b = new CircuitBreaker({ threshold: 3, openMs: 1000, now: () => now });
  for (let i = 0; i < 3; i++) { assert.ok(b.allow()); b.failure(); }
  assert.equal(b.allow(), false);
  now = 1500;
  assert.equal(b.allow(), true);
  assert.equal(b.allow(), false);
  b.success();
  assert.equal(b.allow(), true);
});

test('breaker: a failed probe re-opens, an aborted probe frees the slot', () => {
  let now = 0;
  const b = new CircuitBreaker({ threshold: 1, openMs: 100, now: () => now });
  b.failure(); now = 200;
  assert.ok(b.allow()); b.failure();
  assert.equal(b.allow(), false);
  now = 400;
  assert.ok(b.allow()); b.abort();
  assert.ok(b.allow());
});

test('classifier routes simple, code and hard prompts to different tiers', () => {
  const t = (c) => tierFromScore(heuristicScore([{ role: 'user', content: c }]).score);
  assert.equal(t('What is the capital of France?'), 'cheap');
  assert.notEqual(t('Write a function in ```js``` that debounces calls, with tests and edge cases around cancellation and leading edges.'), 'cheap');
  assert.equal(t('Design a multi-region architecture for payments, analyze the trade-offs step by step and derive the failure probability. ' + 'x'.repeat(700)), 'premium');
});

test('local embedder: normalized near-duplicates match, unrelated text does not', () => {
  assert.ok(cosine(localEmbed('What is the capital of France?'), localEmbed('what is the CAPITAL of france')) > 0.99);
  assert.ok(cosine(localEmbed('What is the capital of France?'), localEmbed('Refactor my kubernetes ingress yaml')) < 0.5);
  const v = localEmbed('hello world');
  assert.deepEqual(Array.from(decodeVec(encodeVec(v))), Array.from(v));
});

test('api keys: format, hashing, constant-time compare', () => {
  const k = newApiKey();
  const p = parseApiKey(k.plaintext);
  assert.equal(p.keyId, k.keyId);
  assert.equal(parseApiKey('gw_short_nope'), null);
  const h = hashSecret(p.secret, 'p'.repeat(32));
  assert.ok(safeEqual(h, hashSecret(k.secret, 'p'.repeat(32))));
  assert.ok(!safeEqual(h, hashSecret(k.secret, 'q'.repeat(32))));
});

test('AES-GCM: round trip, tamper and wrong-tenant AAD both fail', () => {
  const key = Buffer.alloc(32, 7);
  const c = encrypt('secret answer', key, 'tenantA');
  assert.equal(decrypt(c, key, 'tenantA'), 'secret answer');
  assert.throws(() => decrypt(c, key, 'tenantB'));
  const bad = Buffer.from(c, 'base64'); bad[bad.length - 1] ^= 1;
  assert.throws(() => decrypt(bad.toString('base64'), key, 'tenantA'));
});
