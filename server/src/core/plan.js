import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { config } from '../config/config.js';
import { CATALOG, TIERS, tierRank, cost, estTokens } from '../config/catalog.js';
import { CHAINS, chainForModel, isAvailable } from '../config/chains.js';
import { hasSensitive, injectionSignals } from './guard.js';
import { heuristicScore, blend, tierFromScore, lastUser } from './classifier.js';
import { knnScore, EXEMPLARS } from './knn.js';
import { embed, embedMany, embedderId } from './embedder.js';
import { cacheContext, lookupExact, lookupSemantic } from './semanticCache.js';
import { reserve } from '../lib/limits.js';
import { logger } from '../lib/logger.js';

// Why a graph: the request path is an explicit state machine with early exits (reject, cache hit),
// so each step is isolated, testable and traceable. The streaming itself is NOT in the graph:
// graphs are for the decision, the executor (hedge.js) owns the byte-level hot path.
const State = Annotation.Root({
  req: Annotation(), tenant: Annotation(), signals: Annotation(), ctx: Annotation(), emb: Annotation(),
  cache: Annotation(), decision: Annotation(), reservation: Annotation(), outcome: Annotation(), reject: Annotation(),
});

const reject = (status, code, message) => ({ outcome: 'rejected', reject: { status, code, message } });
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);

let bank;
async function getBank() {
  if (!bank) {
    const vecs = await embedMany(EXEMPLARS.map((e) => e.text));
    bank = EXEMPLARS.map((e, i) => ({ ...e, vec: vecs[i] }));
  }
  return bank;
}

async function guard(s) {
  const text = s.req.messages.map((m) => m.content).join('\n');
  const signals = { sensitive: hasSensitive(text), injection: injectionSignals(text) };
  if (config.BLOCK_INJECTION && signals.injection.length) return { signals, ...reject(400, 'policy_violation', 'Request blocked by input policy.') };
  return { signals };
}

const cacheEligible = (s) =>
  config.CACHE_ENABLED && s.tenant.cacheEnabled && !s.req.noCache && !s.signals.sensitive &&
  s.req.temperature <= 0.3 && s.req.messages.at(-1).role === 'user';

// Step 1: exact match costs one Redis GET and no embedding.
async function exact(s) {
  if (!cacheEligible(s)) return { cache: { eligible: false } };
  const ctx = cacheContext(s.req);
  const hit = await lookupExact(s.tenant.id, ctx, s.req.messages.at(-1).content);
  return hit ? { ctx, cache: { eligible: true, hit }, outcome: 'cache_hit' } : { ctx, cache: { eligible: true } };
}

// Step 2: embed once (bounded by a timeout), reuse the vector for semantic lookup, kNN routing and write-back.
async function semantic(s) {
  let emb = null;
  try { emb = await withTimeout(embed(lastUser(s.req.messages)), config.EMBED_TIMEOUT_MS); }
  catch (e) { logger.warn({ err: e.message }, 'embedding skipped'); }
  if (emb && s.cache.eligible) {
    const hit = await lookupSemantic(s.tenant.id, s.ctx, emb, embedderId, config.CACHE_THRESHOLD);
    if (hit) return { emb, cache: { eligible: true, hit }, outcome: 'cache_hit' };
  }
  return { emb };
}

async function classify(s) {
  const { req, tenant } = s;
  const premium = CHAINS.premium[0];
  let tier, reasons, score = null, chain;

  if (req.model !== 'auto' && !TIERS.includes(req.model)) {
    if (!isAvailable(req.model)) return reject(400, 'model_unavailable', 'Requested model is not available.');
    if (tierRank(CATALOG[req.model].tier) > tierRank(tenant.maxTier)) return reject(403, 'tier_not_allowed', 'Model exceeds this tenant\'s tier limit.');
    chain = chainForModel(req.model);
    tier = CATALOG[req.model].tier;
    reasons = ['client_pinned_model'];
  } else if (TIERS.includes(req.model)) {
    if (tierRank(req.model) > tierRank(tenant.maxTier)) return reject(403, 'tier_not_allowed', 'Tier exceeds this tenant\'s limit.');
    tier = req.model;
    reasons = ['client_pinned_tier'];
  } else {
    const h = heuristicScore(req.messages, { maxTokens: req.maxTokens });
    const k = s.emb ? knnScore(s.emb, await getBank()) : null;
    ({ score, reasons } = blend(h, k));
    tier = tierFromScore(score);
    if (tierRank(tier) > tierRank(tenant.maxTier)) { tier = tenant.maxTier; reasons = [...reasons, 'clamped_by_tenant_max_tier']; }
  }
  chain ??= CHAINS[tier];
  return { decision: { tier, score, reasons, chain, baseline: premium ?? chain[0] } };
}

async function budget(s) {
  const { req, tenant, decision } = s;
  const inTok = estTokens(req.messages);
  const worst = Math.max(...decision.chain.map((c) => cost(c, inTok, req.maxTokens))); // price the dearest fallback
  const r = await reserve(tenant.id, worst, tenant.monthlyBudgetMicros);
  if (!r.ok) return reject(402, 'budget_exceeded', 'Monthly budget exhausted.');
  return { reservation: { key: r.key, micros: worst }, outcome: 'proceed' };
}

const graph = new StateGraph(State)
  .addNode('guard', guard)
  .addNode('exact', exact)
  .addNode('semantic', semantic)
  .addNode('classify', classify)
  .addNode('budget', budget)
  .addEdge(START, 'guard')
  .addConditionalEdges('guard', (s) => (s.outcome === 'rejected' ? END : 'exact'))
  .addConditionalEdges('exact', (s) => (s.outcome === 'cache_hit' ? END : 'semantic'))
  .addConditionalEdges('semantic', (s) => (s.outcome === 'cache_hit' ? END : 'classify'))
  .addConditionalEdges('classify', (s) => (s.outcome === 'rejected' ? END : 'budget'))
  .addEdge('budget', END)
  .compile();

export const plan = (req, tenant) => graph.invoke({ req, tenant });

/** Dry run for the MCP `explain_routing` tool: classification only, no cache, no budget, nothing stored. */
export async function explainRouting(messages, maxTokens = 1024) {
  const h = heuristicScore(messages, { maxTokens });
  let emb = null;
  try { emb = await withTimeout(embed(lastUser(messages)), config.EMBED_TIMEOUT_MS); } catch { /* optional */ }
  const { score, reasons } = blend(h, emb ? knnScore(emb, await getBank()) : null);
  const tier = tierFromScore(score);
  return { tier, score: Number(score.toFixed(3)), reasons, chain: CHAINS[tier].map((c) => c.id) };
}
