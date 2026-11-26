import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/config.js';
import { CATALOG, TIERS } from '../config/catalog.js';
import { isAvailable } from '../config/chains.js';
import { authenticate, rateLimitTenant } from './auth.js';
import { sendError } from '../lib/http.js';
import { plan } from '../core/plan.js';
import { hedgedStream } from '../core/hedge.js';
import { isRetryable, getBreaker, report } from '../core/breaker.js';
import { openStream } from '../core/providers.js';
import { finalize, finalizeCacheHit, auditCacheHit } from '../services/finalize.js';

export const chatRouter = Router();

const Message = z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string().max(100_000) });
const ChatSchema = z.object({
  model: z.string().default('auto').refine((v) => v === 'auto' || TIERS.includes(v) || Object.hasOwn(CATALOG, v), 'unknown model'),
  messages: z.array(Message).min(1).max(config.MAX_MESSAGES).refine((m) => m.at(-1).role === 'user', 'last message must have role "user"'),
  stream: z.boolean().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).max(config.MAX_OUTPUT_TOKENS).optional(),
}); // unknown fields (tools, n, top_p...) are stripped, not forwarded

const normalize = (b, noCache) => ({
  model: b.model,
  messages: b.messages.map((m) => ({ role: m.role, content: m.content.replaceAll('\u0000', '') })),
  stream: b.stream,
  temperature: b.temperature ?? config.DEFAULT_TEMPERATURE,
  temperatureExplicit: b.temperature !== undefined,
  maxTokens: b.max_tokens ?? Math.min(1024, config.MAX_OUTPUT_TOKENS),
  noCache: noCache === '1',
});

const chunk = (id, created, model, delta, finish = null) =>
  ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] });
const completion = (id, created, model, content, usage, gateway) => ({
  id, object: 'chat.completion', created, model,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: usage.in, completion_tokens: usage.out, total_tokens: usage.in + usage.out },
  gateway,
});
const sseInit = (res, headers) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...headers });
  res.flushHeaders?.();
};
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const slices = (s, n) => { const o = []; for (let i = 0; i < s.length; i += n) o.push(s.slice(i, i + n)); return o; };
const meta = (tier, model, cache, hedged, planMs) => ({
  'x-gateway-tier': tier, 'x-gateway-model': model, 'x-gateway-cache': cache, 'x-gateway-hedged': hedged ? '1' : '0',
  'server-timing': `plan;dur=${planMs.toFixed(1)}`,
});

chatRouter.get('/models', authenticate, (req, res) => {
  res.json({ object: 'list', data: ['auto', ...TIERS, ...Object.keys(CATALOG).filter(isAvailable)].map((id) => ({ id, object: 'model' })) });
});

chatRouter.post('/chat/completions', authenticate, rateLimitTenant, async (req, res, next) => {
  const parsed = ChatSchema.safeParse(req.body);
  if (!parsed.success) {
    const msg = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    return sendError(res, req, 400, 'invalid_request', msg);
  }
  const creq = normalize(parsed.data, req.header('x-gateway-no-cache'));
  const t0 = performance.now();
  let state;
  try { state = await plan(creq, req.tenant); } catch (e) {
    req.log.error({ err: e.message }, 'plan failed');
    return sendError(res, req, 503, 'service_unavailable', 'Service temporarily unavailable.', { 'Retry-After': '5' });
  }
  const planMs = performance.now() - t0;
  if (state.outcome === 'rejected') {
    return sendError(res, req, state.reject.status, state.reject.code, state.reject.message);
  }

  const ctx = { req, res, creq, state, t0, planMs, id: `chatcmpl-${req.id}`, created: Math.floor(Date.now() / 1000) };
  try {
    return state.outcome === 'cache_hit' ? serveCache(ctx) : await serveLive(ctx);
  } catch (e) { return next(e); }
});

function serveCache({ req, res, creq, state, t0, planMs, id, created }) {
  const { entry, type } = state.cache.hit;
  const headers = meta(entry.tier, entry.model, `hit-${type}`, false, planMs);
  if (creq.stream) {
    sseInit(res, headers);
    sse(res, chunk(id, created, entry.model, { role: 'assistant', content: '' }));
    for (const part of slices(entry.content, 64)) sse(res, chunk(id, created, entry.model, { content: part }));
    sse(res, chunk(id, created, entry.model, {}, 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    res.set(headers).json(completion(id, created, entry.model, entry.content, { in: entry.inTok, out: entry.outTok }, { tier: entry.tier, cache: type, cost_usd: 0 }));
  }
  const ttftMs = Math.round(performance.now() - t0);
  finalizeCacheHit({ tenant: req.tenant, keyId: req.keyId, requestId: req.id, creq, state, ttftMs });
  auditCacheHit({ tenant: req.tenant, creq, state });
}

async function serveLive({ req, res, creq, state, t0, planMs, id, created }) {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); }); // client left: stop paying for tokens
  const out = { text: '', usage: null, cand: null, hedged: false, ttftMs: null, error: null };
  const add = (u) => { if (u) out.usage = { input_tokens: (out.usage?.input_tokens ?? 0) + (u.input_tokens ?? 0), output_tokens: (out.usage?.output_tokens ?? 0) + (u.output_tokens ?? 0) }; };

  try {
    for await (const ev of hedgedStream({
      candidates: state.decision.chain, signal: ac.signal,
      hedgeAfterMs: config.HEDGE_AFTER_MS, idleMs: config.IDLE_TIMEOUT_MS,
      start: (c, sig) => openStream(c, creq, sig),
      allow: (c) => getBreaker(c.id).allow(), report, isRetryable,
    })) {
      if (ev.type === 'start') {
        Object.assign(out, { cand: ev.candidate, hedged: ev.hedged, ttftMs: ev.ttftMs });
        if (creq.stream) {
          sseInit(res, meta(state.decision.tier, ev.candidate.model, state.cache?.eligible ? 'miss' : 'bypass', ev.hedged, planMs));
          sse(res, chunk(id, created, ev.candidate.model, { role: 'assistant', content: '' }));
        }
      } else {
        add(ev.value.usage);
        if (ev.value.text) {
          out.text += ev.value.text;
          if (creq.stream) sse(res, chunk(id, created, out.cand.model, { content: ev.value.text }));
        }
      }
    }
  } catch (e) { out.error = e; }

  const clientGone = ac.signal.aborted;
  const status = !out.error ? 'ok' : clientGone ? 'client_abort' : 'error';
  const totalMs = Math.round(performance.now() - t0);
  const acct = finalize({ tenant: req.tenant, keyId: req.keyId, requestId: req.id, creq, state, out, status, totalMs });

  if (clientGone) return res.end();
  if (out.error) {
    req.log.error({ code: out.error.code, status: out.error.status, msg: out.error.message }, 'upstream failure'); // server log only
    const [http, code] = out.error.code === 'all_providers_unavailable' ? [503, 'providers_unavailable'] : out.error.code === 'idle_timeout' ? [504, 'upstream_timeout'] : [502, 'upstream_error'];
    if (res.headersSent) { sse(res, { error: { type: code, message: 'Upstream failed mid-stream.', request_id: req.id } }); res.write('data: [DONE]\n\n'); return res.end(); }
    return sendError(res, req, http, code, 'The upstream model provider failed. Please retry.');
  }

  const gw = { tier: state.decision.tier, reasons: state.decision.reasons, hedged: out.hedged, cost_usd: acct.costMicros / 1e6, saved_usd: (acct.baselineMicros - acct.costMicros) / 1e6 };
  if (creq.stream) {
    sse(res, chunk(id, created, out.cand.model, {}, 'stop'));
    sse(res, { ...chunk(id, created, out.cand.model, {}), choices: [], usage: { prompt_tokens: acct.inTok, completion_tokens: acct.outTok, total_tokens: acct.inTok + acct.outTok }, gateway: gw });
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  res.set(meta(state.decision.tier, out.cand.model, state.cache?.eligible ? 'miss' : 'bypass', out.hedged, planMs))
    .json(completion(id, created, out.cand.model, out.text, { in: acct.inTok, out: acct.outTok }, gw));
}
