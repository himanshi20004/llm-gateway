// Usage: GATEWAY_KEY=gw_... node scripts/bench.js [url] [requests] [concurrency] [--cache]
// To isolate gateway overhead, start the server with MOCK_BASE_MS=0 MOCK_TOKEN_MS=0 and ENABLE_MOCK=true:
// then TTFT is almost entirely gateway time. Each request is unique unless --cache is passed.
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const [url = 'http://localhost:8080', n = '500', c = '20'] = args;
const sameCache = process.argv.includes('--cache');
const key = process.env.GATEWAY_KEY;
if (!key) { console.error('Set GATEWAY_KEY'); process.exit(1); }

const ttft = [], total = [], plan = [];
let ok = 0, fail = 0, i = 0;
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]?.toFixed(1);

async function one() {
  const prompt = sameCache ? 'What is the capital of France?' : `Explain topic #${Math.random().toString(36).slice(2)} briefly`;
  const t0 = performance.now();
  try {
    const r = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], stream: true }),
    });
    if (!r.ok) { fail++; await r.text(); return; }
    const m = /dur=([\d.]+)/.exec(r.headers.get('server-timing') || '');
    if (m) plan.push(Number(m[1]));
    const reader = r.body.getReader();
    let first = true;
    for (;;) {
      const { done } = await reader.read();
      if (first) { ttft.push(performance.now() - t0); first = false; }
      if (done) break;
    }
    total.push(performance.now() - t0);
    ok++;
  } catch { fail++; }
}

const t0 = performance.now();
await Promise.all(Array.from({ length: Number(c) }, async () => { while (i++ < Number(n)) await one(); }));
const secs = (performance.now() - t0) / 1000;
console.log(`requests ok=${ok} fail=${fail}  throughput=${(ok / secs).toFixed(0)} req/s`);
console.log(`TTFT  ms  p50=${q(ttft, 0.5)}  p95=${q(ttft, 0.95)}  p99=${q(ttft, 0.99)}`);
console.log(`total ms  p50=${q(total, 0.5)}  p95=${q(total, 0.95)}  p99=${q(total, 0.99)}`);
console.log(`plan  ms (server-timing)  p50=${q(plan, 0.5)}  p95=${q(plan, 0.95)}  p99=${q(plan, 0.99)}`);
