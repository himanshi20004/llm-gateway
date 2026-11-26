import mongoose from 'mongoose';
import { config } from '../config/config.js';
import { newApiKey, hashSecret } from '../lib/crypto.js';
import { currentSpend } from '../lib/limits.js';
import { ApiKeyModel, TenantModel, UsageLogModel } from '../lib/models.js';

export const usdToMicros = (usd) => Math.round(usd * 1e6);
const microsToUsd = (m) => Number((m / 1e6).toFixed(6));
const oid = (id) => new mongoose.Types.ObjectId(id);

const present = async (t) => ({
  id: String(t._id), name: t.name, status: t.status, rpm: t.rpm, maxTier: t.maxTier, cacheEnabled: t.cacheEnabled,
  monthlyBudgetUsd: microsToUsd(t.monthlyBudgetMicros), spentUsd: microsToUsd(await currentSpend(String(t._id))),
});

export async function createTenant({ name, monthlyBudgetUsd, rpm, maxTier }) {
  const t = await TenantModel.create({ name, monthlyBudgetMicros: usdToMicros(monthlyBudgetUsd), ...(rpm && { rpm }), ...(maxTier && { maxTier }) });
  return present(t);
}

export async function listTenants() {
  return Promise.all((await TenantModel.find().sort({ createdAt: -1 }).limit(200).lean()).map(present));
}

export async function updateTenant(id, patch) {
  const set = {};
  if (patch.monthlyBudgetUsd !== undefined) set.monthlyBudgetMicros = usdToMicros(patch.monthlyBudgetUsd);
  for (const k of ['rpm', 'status', 'maxTier', 'cacheEnabled']) if (patch[k] !== undefined) set[k] = patch[k];
  const t = await TenantModel.findByIdAndUpdate(oid(id), { $set: set }, { new: true, runValidators: true }).lean();
  return t ? present(t) : null;
}

/** The plaintext key is returned exactly once; only its HMAC is stored. */
export async function createKey(tenantId, label = '') {
  if (!(await TenantModel.exists({ _id: oid(tenantId) }))) return null;
  const k = newApiKey();
  await ApiKeyModel.create({ keyId: k.keyId, tenantId: oid(tenantId), hash: hashSecret(k.secret, config.API_KEY_PEPPER), label });
  return { keyId: k.keyId, apiKey: k.plaintext };
}

export async function revokeKey(keyId) {
  const r = await ApiKeyModel.updateOne({ keyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  return r.modifiedCount === 1;
}

export async function usageSummary({ tenantId, days = 7 }) {
  const match = { ts: { $gte: new Date(Date.now() - days * 864e5) }, ...(tenantId && { tenantId: oid(tenantId) }) };
  const [tot] = await UsageLogModel.aggregate([
    { $match: match },
    { $group: {
      _id: null, requests: { $sum: 1 }, costMicros: { $sum: '$costMicros' }, baselineMicros: { $sum: '$baselineMicros' },
      cacheHits: { $sum: { $cond: ['$cacheHit', 1, 0] } }, hedged: { $sum: { $cond: ['$hedged', 1, 0] } },
      errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
      inputTokens: { $sum: '$inputTokens' }, outputTokens: { $sum: '$outputTokens' },
      ttft: { $percentile: { input: '$ttftMs', p: [0.5, 0.99], method: 'approximate' } },
    } },
  ]);
  const byTier = await UsageLogModel.aggregate([
    { $match: match },
    { $group: { _id: '$tier', requests: { $sum: 1 }, costMicros: { $sum: '$costMicros' } } },
    { $sort: { requests: -1 } },
  ]);
  const t = tot ?? { requests: 0, costMicros: 0, baselineMicros: 0, cacheHits: 0, hedged: 0, errors: 0, inputTokens: 0, outputTokens: 0, ttft: [null, null] };
  return {
    days, requests: t.requests, errors: t.errors, hedged: t.hedged,
    spendUsd: microsToUsd(t.costMicros), baselineUsd: microsToUsd(t.baselineMicros),
    savingsPct: t.baselineMicros ? Number((100 * (1 - t.costMicros / t.baselineMicros)).toFixed(1)) : 0,
    cacheHitPct: t.requests ? Number((100 * t.cacheHits / t.requests).toFixed(1)) : 0,
    inputTokens: t.inputTokens, outputTokens: t.outputTokens,
    ttftMs: { p50: t.ttft?.[0] ?? null, p99: t.ttft?.[1] ?? null },
    byTier: byTier.map((x) => ({ tier: x._id ?? 'unknown', requests: x.requests, spendUsd: microsToUsd(x.costMicros) })),
  };
}

export async function topSpenders({ days = 7, limit = 5 }) {
  const rows = await UsageLogModel.aggregate([
    { $match: { ts: { $gte: new Date(Date.now() - days * 864e5) } } },
    { $group: { _id: '$tenantId', costMicros: { $sum: '$costMicros' }, requests: { $sum: 1 } } },
    { $sort: { costMicros: -1 } }, { $limit: limit },
  ]);
  const names = new Map((await TenantModel.find({ _id: mongoose.trusted({ $in: rows.map((r) => r._id) }) }, 'name').lean()).map((t) => [String(t._id), t.name]));
  return rows.map((r) => ({ tenantId: String(r._id), name: names.get(String(r._id)) ?? 'unknown', requests: r.requests, spendUsd: microsToUsd(r.costMicros) }));
}

export const tenantSpend = async (tenantId) => microsToUsd(await currentSpend(tenantId));
