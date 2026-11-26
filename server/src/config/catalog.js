export const TIERS = ['cheap', 'mid', 'premium'];
export const tierRank = (t) => TIERS.indexOf(t);

// PLACEHOLDER PRICES (USD per 1M tokens). Copy the real numbers from each provider's pricing
// page before trusting any cost or savings figure. Model IDs also change: verify them too.
export const CATALOG = {
  'anthropic:claude-haiku-5-5': { provider: 'anthropic', model: 'claude-haiku-5-5', tier: 'cheap', inPerM: 1, outPerM: 5 },
  'anthropic:claude-sonnet-5-5': { provider: 'anthropic', model: 'claude-sonnet-5-5', tier: 'mid', inPerM: 3, outPerM: 15 },
  'anthropic:claude-opus-5-5': { provider: 'anthropic', model: 'claude-opus-5-5', tier: 'premium', inPerM: 5, outPerM: 25 },
  'openai:gpt-4o-mini': { provider: 'openai', model: 'gpt-4o-mini', tier: 'cheap', inPerM: 0.15, outPerM: 0.6 },
  'openai:gpt-4o': { provider: 'openai', model: 'gpt-4o', tier: 'mid', inPerM: 2.5, outPerM: 10 },
  'mock:cheap': { provider: 'mock', model: 'mock-cheap', tier: 'cheap', inPerM: 0.1, outPerM: 0.4 },
  'mock:mid': { provider: 'mock', model: 'mock-mid', tier: 'mid', inPerM: 1, outPerM: 4 },
  'mock:premium': { provider: 'mock', model: 'mock-premium', tier: 'premium', inPerM: 5, outPerM: 20 },
  // Groq: hosted open models with a free plan (no card). Notional prices only; model ids come from GROQ_MODEL_* in .env.
  'groq:cheap': { provider: 'groq', model: 'llama-3.1-8b-instant', tier: 'cheap', inPerM: 0.1, outPerM: 0.4, notional: true },
  'groq:mid': { provider: 'groq', model: 'llama-3.3-70b-versatile', tier: 'mid', inPerM: 1, outPerM: 4, notional: true },
  'groq:premium': { provider: 'groq', model: 'llama-3.3-70b-versatile', tier: 'premium', inPerM: 5, outPerM: 20, notional: true },
  // Local models served by Ollama: free to run (real cost $0). Prices are NOTIONAL (roughly what a comparable
  // hosted model would charge) so budgets and "savings" stay meaningful. Model names come from OLLAMA_MODEL_* in .env.
  'ollama:cheap': { provider: 'ollama', model: 'llama3.2:3b', tier: 'cheap', inPerM: 0.1, outPerM: 0.4, notional: true },
  'ollama:mid': { provider: 'ollama', model: 'qwen2.5:7b', tier: 'mid', inPerM: 1, outPerM: 4, notional: true },
  'ollama:premium': { provider: 'ollama', model: 'qwen2.5:7b', tier: 'premium', inPerM: 5, outPerM: 20, notional: true },
  'mock:backup': { provider: 'mock', model: 'mock-backup', tier: 'mid', inPerM: 1, outPerM: 4 },
};
for (const [id, m] of Object.entries(CATALOG)) m.id = id;

// $ per 1M tokens x tokens = micro-dollars exactly, so money is always an integer.
export const cost = (m, inTok, outTok) => Math.round(inTok * m.inPerM + outTok * m.outPerM);

export const estTokens = (messages) =>
  Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4) + 4 * messages.length;
