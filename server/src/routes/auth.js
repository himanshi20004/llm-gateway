import { config } from '../config/config.js';
import { parseApiKey, hashSecret, safeEqual, sha256 } from '../lib/crypto.js';
import { sendError } from '../lib/http.js';
import { takeRequestToken } from '../lib/limits.js';
import { ApiKeyModel, TenantModel } from '../lib/models.js';

// Small in-process cache so the Mongo lookup is off the hot path. Trade-off: a revoked key or suspended
// tenant keeps working on this instance for up to AUTH_TTL_MS. Keep it short.
const AUTH_TTL_MS = 15_000;
const authCache = new Map();

const deny = (res, req) => sendError(res, req, 401, 'invalid_api_key', 'Invalid or missing API key.', { 'WWW-Authenticate': 'Bearer' });

export async function authenticate(req, res, next) {
  try {
    const m = /^Bearer (\S+)$/i.exec(req.header('authorization') || '');
    const parsed = m && parseApiKey(m[1]);
    if (!parsed) return deny(res, req);

    const cacheId = sha256(m[1]);
    const hit = authCache.get(cacheId);
    if (hit && hit.exp > Date.now()) {
      req.tenant = hit.tenant;
      req.keyId = parsed.keyId;
      return next();
    }

    const presented = hashSecret(parsed.secret, config.API_KEY_PEPPER); // always hashed, even if the key id is unknown
    const doc = await ApiKeyModel.findOne({ keyId: parsed.keyId, revokedAt: null }).lean();
    if (!doc || !safeEqual(doc.hash, presented)) return deny(res, req);

    const t = await TenantModel.findById(doc.tenantId).lean();
    if (!t || t.status !== 'active') return sendError(res, req, 403, 'tenant_suspended', 'Tenant is not active.');

    const tenant = {
      id: String(t._id), name: t.name, monthlyBudgetMicros: t.monthlyBudgetMicros,
      rpm: t.rpm, maxTier: t.maxTier, cacheEnabled: t.cacheEnabled,
    };
    if (authCache.size > 10_000) authCache.clear();
    authCache.set(cacheId, { tenant, exp: Date.now() + AUTH_TTL_MS });
    ApiKeyModel.updateOne({ _id: doc._id }, { lastUsedAt: new Date() }).catch(() => {});
    req.tenant = tenant;
    req.keyId = parsed.keyId;
    next();
  } catch (e) {
    next(e);
  }
}

/** Fails CLOSED: if Redis is unavailable we refuse traffic rather than run without limits or budgets. */
export async function rateLimitTenant(req, res, next) {
  try {
    const r = await takeRequestToken(req.tenant.id, req.tenant.rpm);
    if (!r.allowed) return sendError(res, req, 429, 'rate_limited', 'Rate limit exceeded.', { 'Retry-After': String(r.retryAfterSec) });
    next();
  } catch {
    sendError(res, req, 503, 'limiter_unavailable', 'Service temporarily unavailable.', { 'Retry-After': '5' });
  }
}

export function adminAuth(req, res, next) {
  if (!safeEqual(req.header('x-admin-key') || '', config.ADMIN_API_KEY)) {
    return sendError(res, req, 401, 'invalid_admin_key', 'Invalid admin key.');
  }
  next();
}
