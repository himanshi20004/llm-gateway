import { redis } from './redis.js';

const monthKey = (d = new Date()) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
export const spendKey = (tenantId) => `spend:${tenantId}:${monthKey()}`;

/** Per-tenant requests/min as a token bucket. Throws if Redis is down (callers fail closed). */
export async function takeRequestToken(tenantId, rpm) {
  const refill = rpm / 60;
  const [ok, tokens] = await redis.tokenBucket(`rl:${tenantId}`, rpm, refill, 1);
  return { allowed: ok === 1, retryAfterSec: ok === 1 ? 0 : Math.max(1, Math.ceil((1 - Number(tokens)) / refill)) };
}

export async function reserve(tenantId, estMicros, limitMicros) {
  const key = spendKey(tenantId);
  const [ok, spent] = await redis.budgetReserve(key, estMicros, limitMicros, 35 * 86400);
  return { ok: ok === 1, key, spent: Number(spent) };
}

export const settle = (key, deltaMicros) => redis.budgetSettle(key, Math.round(deltaMicros));
export const currentSpend = async (tenantId) => Number((await redis.get(spendKey(tenantId))) ?? 0);
