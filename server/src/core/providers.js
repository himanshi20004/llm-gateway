import { config } from '../config/config.js';
import { estTokens } from '../config/catalog.js';

const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const sleep = (ms, signal) =>
  new Promise((res, rej) => {
    if (signal?.aborted) return rej(abortErr());
    const ab = () => { clearTimeout(t); rej(abortErr()); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', ab); res(); }, ms);
    signal?.addEventListener('abort', ab, { once: true });
  });

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

// Mock provider for local dev and load tests. Env knobs: MOCK_BASE_MS, MOCK_TOKEN_MS,
// MOCK_SLOW_MODELS (first token delayed by MOCK_FIRST_TOKEN_MS), MOCK_FAIL_MODELS (HTTP 503).
async function* mockGen(cand, req, signal) {
  if (list(process.env.MOCK_FAIL_MODELS).includes(cand.id)) throw Object.assign(new Error('mock upstream 503'), { status: 503 });
  const slow = list(process.env.MOCK_SLOW_MODELS).includes(cand.id);
  await sleep(slow ? Number(process.env.MOCK_FIRST_TOKEN_MS || 5000) : Number(process.env.MOCK_BASE_MS ?? 20), signal);
  const last = req.messages.at(-1).content.slice(0, 80);
  const words = `[${cand.id}] Mock answer to: ${last}. This is a simulated streaming completion for development and load testing.`.split(' ');
  for (const w of words) {
    await sleep(Number(process.env.MOCK_TOKEN_MS ?? 5), signal);
    yield { text: w + ' ' };
  }
  yield { text: '', usage: { input_tokens: estTokens(req.messages), output_tokens: words.length * 2 } };
}

const chunkText = (c) =>
  typeof c.content === 'string' ? c.content : (c.content ?? []).map((p) => (p?.type === 'text' ? p.text : '')).join('');

async function buildModel(cand, req) {
  const common = {
    model: cand.model,
    maxRetries: 0, // retries are the gateway's job (failover/hedging), not the SDK's
    timeout: 60_000,
    maxTokens: req.maxTokens,
    ...(req.temperatureExplicit ? { temperature: req.temperature } : {}), // never force a param some models reject
  };
  if (cand.provider === 'openai') {
    const { ChatOpenAI } = await import('@langchain/openai');
    return new ChatOpenAI({ ...common, apiKey: config.OPENAI_API_KEY, streamUsage: true });
  }
  if (cand.provider === 'groq') {
    // Groq speaks the OpenAI API. Usage streaming is left off (estimated instead) so an unsupported option can never cause a 400.
    const { ChatOpenAI } = await import('@langchain/openai');
    return new ChatOpenAI({ ...common, apiKey: config.GROQ_API_KEY, streamUsage: false, configuration: { baseURL: 'https://api.groq.com/openai/v1' } });
  }
  if (cand.provider === 'ollama') {
    // Ollama exposes an OpenAI-compatible API at /v1; local CPU models are slow, so allow a long timeout.
    const { ChatOpenAI } = await import('@langchain/openai');
    return new ChatOpenAI({ ...common, timeout: 180_000, apiKey: 'ollama', streamUsage: true, configuration: { baseURL: `${config.OLLAMA_BASE_URL}/v1` } });
  }
  if (cand.provider === 'anthropic') {
    const { ChatAnthropic } = await import('@langchain/anthropic');
    return new ChatAnthropic({ ...common, apiKey: config.ANTHROPIC_API_KEY });
  }
  throw new Error(`unsupported provider ${cand.provider}`);
}

/** Opens a stream and returns an async iterator of { text, usage? } (the shape hedgedStream expects). */
export async function openStream(cand, req, signal) {
  if (cand.provider === 'mock') return mockGen(cand, req, signal);
  const model = await buildModel(cand, req);
  const stream = await model.stream(req.messages, { signal });
  const it = stream[Symbol.asyncIterator]();
  return {
    async next() {
      const r = await it.next();
      return r.done ? r : { done: false, value: { text: chunkText(r.value), usage: r.value.usage_metadata } };
    },
    async return() { return it.return?.() ?? { done: true }; },
  };
}
