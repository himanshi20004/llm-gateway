import { config } from '../config/config.js';
import { CHAINS } from '../config/chains.js';
import { cost, estTokens } from '../config/catalog.js';
import { settle } from '../lib/limits.js';
import { sha256 } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { UsageLogModel, CacheAuditModel } from '../lib/models.js';
import { store } from '../core/semanticCache.js';
import { embed, embedderId } from '../core/embedder.js';
import { cosine } from '../core/embeddings.js';
import { openStream } from '../core/providers.js';

const bg = (p, what) => p.catch((e) => logger.error({ err: e.message }, `${what} failed`));
const promptHash = (creq) => sha256(creq.messages.map((m) => m.content).join('\n')); // hash only, never the text

/** Called once per live (non-cache) request. Everything here is fire-and-forget off the response path. */
export function finalize({ tenant, keyId, requestId, creq, state, out, status, totalMs }) {
  const cand = out.cand;
  const billed = cand && out.text.length > 0;
  const inTok = out.usage?.input_tokens || estTokens(creq.messages);
  const outTok = out.usage?.output_tokens || Math.ceil(out.text.length / 4);
  const costMicros = billed ? cost(cand, inTok, outTok) : 0;
  const baselineMicros = billed ? cost(state.decision.baseline, inTok, outTok) : 0;

  // Release the over-reservation (or charge the overage). On failure before any token: refund all.
  bg(settle(state.reservation.key, costMicros - state.reservation.micros), 'budget settle');

  bg(UsageLogModel.create({
    tenantId: tenant.id, keyId, requestId, tier: state.decision.tier, model: cand?.model, provider: cand?.provider,
    hedged: out.hedged, status, errorCode: out.error?.code || (out.error ? 'upstream_error' : undefined),
    inputTokens: inTok, outputTokens: outTok, costMicros, baselineMicros, ttftMs: out.ttftMs, totalMs,
    promptHash: promptHash(creq), flags: [...state.signals.injection, ...(state.signals.sensitive ? ['sensitive'] : [])],
  }), 'usage log');

  if (status === 'ok' && state.cache?.eligible && out.text && out.text.length < 32_000) {
    bg(store({
      tenantId: tenant.id, ctx: state.ctx, text: creq.messages.at(-1).content, emb: state.emb, eid: embedderId,
      entry: { content: out.text, model: cand.model, modelId: cand.id, tier: state.decision.tier, inTok, outTok, at: Date.now() },
    }), 'cache store');
  }
  return { costMicros, baselineMicros, inTok, outTok };
}

export function finalizeCacheHit({ tenant, keyId, requestId, creq, state, ttftMs }) {
  const { entry, type } = state.cache.hit;
  const baselineMicros = cost(CHAINS.premium[0] ?? CHAINS.cheap[0], entry.inTok, entry.outTok);
  bg(UsageLogModel.create({
    tenantId: tenant.id, keyId, requestId, tier: entry.tier, model: entry.model, cacheHit: true, cacheType: type,
    status: 'ok', inputTokens: entry.inTok, outputTokens: entry.outTok, costMicros: 0, baselineMicros,
    ttftMs, totalMs: ttftMs, promptHash: promptHash(creq),
  }), 'usage log');
}

/**
 * Shadow evaluation of the cache: for a small sample of hits, also get a fresh answer from the cheap tier
 * and compare it to the cached one. A low similarity means the cache served a wrong-ish answer, so this is
 * how false positives are measured. Runs entirely in the background and is not billed to the tenant.
 */
export async function auditCacheHit({ tenant, creq, state }) {
  if (Math.random() >= config.AUDIT_SAMPLE_RATE) return;
  const { entry, type } = state.cache.hit;
  const cand = CHAINS.cheap[0];
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const it = await openStream(cand, creq, ctrl.signal);
    let fresh = '';
    for (let r = await it.next(); !r.done; r = await it.next()) fresh += r.value.text;
    const [a, b] = await Promise.all([embed(entry.content), embed(fresh)]);
    const similarity = cosine(a, b);
    await CacheAuditModel.create({ tenantId: tenant.id, hitType: type, model: cand.id, similarity, flagged: similarity < 0.8 });
    if (similarity < 0.8) logger.warn({ similarity, hitType: type }, 'cache audit: possible false positive');
  } catch (e) {
    logger.warn({ err: e.message }, 'cache audit skipped');
  } finally {
    clearTimeout(timeout);
  }
}
