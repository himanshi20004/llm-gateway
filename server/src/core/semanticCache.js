import { redis } from '../lib/redis.js';
import { config } from '../config/config.js';
import { sha256, encrypt, decrypt } from '../lib/crypto.js';
import { cosine, encodeVec, decodeVec } from './embeddings.js';

// Isolation rules (cache poisoning / cross-tenant leakage are the main risks of any shared cache):
//  1. Every key is namespaced by tenant; ciphertext is bound to the tenant through AES-GCM AAD.
//  2. Entries live in Redis only as ciphertext; exact-match keys are hashes, never plaintext prompts.
//  3. A match requires the *same conversation prefix* (system prompt, earlier turns, model, temperature
//     bucket). Only the last user message is compared semantically.
const KEY = Buffer.from(config.CACHE_ENCRYPTION_KEY, 'base64');
const seal = (obj, tenantId) => encrypt(JSON.stringify(obj), KEY, tenantId);
const open = (s, tenantId) => {
  try { return JSON.parse(decrypt(s, KEY, tenantId)); } catch { return null; } // tampered/foreign entry = miss
};

export const cacheContext = (creq) =>
  sha256(JSON.stringify([creq.model, creq.messages.slice(0, -1), Math.round((creq.temperature ?? 0.2) * 10)]));

const exactKey = (t, ctx, text) => `ec:${t}:${sha256(`${ctx}\n${text}`)}`;
const listKey = (t, eid, ctx) => `sc:${t}:${eid}:${ctx}`;

export async function lookupExact(tenantId, ctx, text) {
  const raw = await redis.get(exactKey(tenantId, ctx, text));
  const entry = raw && open(raw, tenantId);
  return entry ? { type: 'exact', sim: 1, entry } : null;
}

export async function lookupSemantic(tenantId, ctx, emb, eid, threshold) {
  const items = await redis.lrange(listKey(tenantId, eid, ctx), 0, -1);
  let best = null;
  let bestSim = -1;
  for (const raw of items) {
    const e = open(raw, tenantId);
    if (!e) continue;
    const sim = cosine(emb, decodeVec(e.v));
    if (sim > bestSim) { best = e; bestSim = sim; }
  }
  return best && bestSim >= threshold ? { type: 'semantic', sim: bestSim, entry: best } : null;
}

export async function store({ tenantId, ctx, text, emb, eid, entry }) {
  const ttl = config.CACHE_TTL_SECONDS;
  await redis.set(exactKey(tenantId, ctx, text), seal(entry, tenantId), 'EX', ttl);
  if (!emb) return;
  const k = listKey(tenantId, eid, ctx);
  await redis
    .multi()
    .lpush(k, seal({ ...entry, v: encodeVec(emb) }, tenantId))
    .ltrim(k, 0, config.CACHE_MAX_ENTRIES - 1)
    .expire(k, ttl)
    .exec();
}
