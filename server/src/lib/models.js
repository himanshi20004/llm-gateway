import mongoose from 'mongoose';
import { TIERS } from '../config/catalog.js';

const { Schema } = mongoose;

const Tenant = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80, unique: true },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    monthlyBudgetMicros: { type: Number, required: true, min: 0 }, // micro-USD, integer
    rpm: { type: Number, default: 60, min: 1, max: 100_000 },
    maxTier: { type: String, enum: TIERS, default: 'premium' }, // cost guardrail: cap the tier a tenant can reach
    cacheEnabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// Only the HMAC of the secret is stored; the plaintext key is shown once at creation.
const ApiKey = new Schema(
  {
    keyId: { type: String, required: true, unique: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    hash: { type: String, required: true },
    label: { type: String, maxlength: 80, default: '' },
    revokedAt: { type: Date, default: null },
    lastUsedAt: Date,
  },
  { timestamps: true },
);

// No prompt or completion text is ever stored here: only a prompt hash and counters.
const UsageLog = new Schema({
  ts: { type: Date, default: Date.now },
  tenantId: { type: Schema.Types.ObjectId, required: true },
  keyId: String,
  requestId: String,
  tier: String,
  model: String,
  provider: String,
  cacheHit: { type: Boolean, default: false },
  cacheType: String,
  hedged: { type: Boolean, default: false },
  status: { type: String, enum: ['ok', 'error', 'client_abort'] },
  errorCode: String,
  inputTokens: Number,
  outputTokens: Number,
  costMicros: Number,
  baselineMicros: Number, // what an all-premium setup would have paid for the same tokens
  ttftMs: Number,
  totalMs: Number,
  promptHash: String,
  flags: [String],
});
UsageLog.index({ tenantId: 1, ts: -1 });
UsageLog.index({ ts: 1 }, { expireAfterSeconds: 90 * 86400 });

const CacheAudit = new Schema({
  ts: { type: Date, default: Date.now, expires: 90 * 86400 },
  tenantId: Schema.Types.ObjectId,
  hitType: String,
  model: String,
  similarity: Number,
  flagged: Boolean,
});

const m = (name, s) => mongoose.models[name] || mongoose.model(name, s);
export const TenantModel = m('Tenant', Tenant);
export const ApiKeyModel = m('ApiKey', ApiKey);
export const UsageLogModel = m('UsageLog', UsageLog);
export const CacheAuditModel = m('CacheAudit', CacheAudit);
