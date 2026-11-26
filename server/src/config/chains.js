import { config } from './config.js';
import { CATALOG, TIERS } from './catalog.js';

// Providers that cannot incur a bill. With FREE_ONLY=true (the default) nothing else is ever used.
// Groq counts as free ONLY while the account stays on Groq's free plan (no billing attached): nothing in code can verify that.
const FREE_PROVIDERS = new Set(['mock', 'ollama', 'groq']);
const hasKey = { anthropic: !!config.ANTHROPIC_API_KEY, openai: !!config.OPENAI_API_KEY };
if (config.FREE_ONLY && (hasKey.anthropic || hasKey.openai)) {
  console.warn('[free-only] Paid provider keys are set but FREE_ONLY=true: they will be ignored.');
}
const paidUsable = (p) => !config.FREE_ONLY && hasKey[p];
// Mock models are on by default only in dev when no other provider is usable. In production they need ENABLE_MOCK=true.
const mockOn = config.ENABLE_MOCK ?? (config.NODE_ENV !== 'production' && !config.ENABLE_OLLAMA && !config.GROQ_API_KEY && !paidUsable('anthropic') && !paidUsable('openai'));
const available = (id) => {
  const p = CATALOG[id].provider;
  if (config.FREE_ONLY && !FREE_PROVIDERS.has(p)) return false;
  if (p === 'mock') return mockOn;
  if (p === 'ollama') return config.ENABLE_OLLAMA;
  if (p === 'groq') return !!config.GROQ_API_KEY;
  return hasKey[p];
};

// Ollama model names are configurable (OLLAMA_MODEL_*), so apply them to the catalog once at startup.
CATALOG['groq:cheap'].model = config.GROQ_MODEL_CHEAP;
CATALOG['groq:mid'].model = config.GROQ_MODEL_MID;
CATALOG['groq:premium'].model = config.GROQ_MODEL_PREMIUM;
CATALOG['ollama:cheap'].model = config.OLLAMA_MODEL_CHEAP;
CATALOG['ollama:mid'].model = config.OLLAMA_MODEL_MID;
CATALOG['ollama:premium'].model = config.OLLAMA_MODEL_PREMIUM;

const DEFAULTS = {
  cheap: ['groq:cheap', 'ollama:cheap', 'ollama:mid', 'anthropic:claude-haiku-5-5', 'openai:gpt-4o-mini', 'mock:cheap', 'mock:backup'],
  mid: ['groq:mid', 'ollama:mid', 'anthropic:claude-sonnet-5-5', 'openai:gpt-4o', 'mock:mid', 'mock:backup'],
  premium: ['groq:premium', 'ollama:premium', 'anthropic:claude-opus-5-5', 'openai:gpt-4o', 'mock:premium', 'mock:backup'],
};

function resolve(tier) {
  const raw = config[`TIER_${tier.toUpperCase()}`];
  const ids = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULTS[tier];
  for (const id of ids) {
    // hasOwn, not `in`: client-controlled strings must never hit Object.prototype keys.
    if (!Object.hasOwn(CATALOG, id)) throw new Error(`Unknown model "${id}" in TIER_${tier.toUpperCase()}`);
  }
  return ids.filter(available).map((id) => CATALOG[id]);
}

export const CHAINS = Object.fromEntries(TIERS.map((t) => [t, resolve(t)]));
export const isAvailable = (id) => Object.hasOwn(CATALOG, id) && available(id);

export function assertProviders() {
  for (const t of TIERS) {
    if (!CHAINS[t].length) throw new Error(`No usable provider for tier "${t}". Set GROQ_API_KEY (free plan), ENABLE_OLLAMA=true, ENABLE_MOCK=true, or (with FREE_ONLY=false) a paid provider key.`);
  }
}

/** Chain for a pinned model: that model first, then its tier's fallbacks. */
export const chainForModel = (id) => [CATALOG[id], ...CHAINS[CATALOG[id].tier].filter((c) => c.id !== id)];
