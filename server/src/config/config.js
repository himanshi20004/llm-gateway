import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Loads <repo>/.env (compose and CI inject real env vars; a missing file is ignored).
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const optBool = z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true'));
const b64Key32 = z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64 encoded (openssl rand -base64 32)');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(8080),
    MONGO_URI: z.string().min(1),
    REDIS_URL: z.string().min(1),

    // Secrets. Never defaulted: a missing secret must stop the process.
    API_KEY_PEPPER: z.string().min(32, 'API_KEY_PEPPER must be at least 32 chars'),
    ADMIN_API_KEY: z.string().min(32, 'ADMIN_API_KEY must be at least 32 chars'),
    CACHE_ENCRYPTION_KEY: b64Key32,

    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    // Zero-cost guard: while true, paid providers (Anthropic/OpenAI) are never used, even if a key is set.
    FREE_ONLY: bool.default('true'),
    GROQ_API_KEY: z.string().optional(), // free plan only: do not add billing to the Groq account
    GROQ_MODEL_CHEAP: z.string().default('llama-3.1-8b-instant'),
    GROQ_MODEL_MID: z.string().default('llama-3.3-70b-versatile'),
    GROQ_MODEL_PREMIUM: z.string().default('llama-3.3-70b-versatile'),
    ENABLE_OLLAMA: bool.default('false'),
    OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
    OLLAMA_MODEL_CHEAP: z.string().default('llama3.2:3b'),
    OLLAMA_MODEL_MID: z.string().default('qwen2.5:7b'),
    OLLAMA_MODEL_PREMIUM: z.string().default('qwen2.5:7b'),
    OLLAMA_EMBED_MODEL: z.string().default('nomic-embed-text'),
    OPENAI_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    ENABLE_MOCK: optBool,
    TIER_CHEAP: z.string().optional(),
    TIER_MID: z.string().optional(),
    TIER_PREMIUM: z.string().optional(),

    EMBEDDINGS: z.enum(['local', 'ollama', 'openai']).default('local'),
    EMBED_TIMEOUT_MS: z.coerce.number().int().default(400),
    CACHE_ENABLED: bool.default('true'),
    CACHE_THRESHOLD: z.coerce.number().min(0.8).max(1).default(0.95),
    CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(500).default(50),
    CACHE_TTL_SECONDS: z.coerce.number().int().default(86400),
    AUDIT_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.02),

    HEDGE_AFTER_MS: z.coerce.number().int().default(2500),
    IDLE_TIMEOUT_MS: z.coerce.number().int().default(20000),
    DEFAULT_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
    BLOCK_INJECTION: bool.default('false'),

    MAX_BODY_KB: z.coerce.number().int().default(256),
    MAX_MESSAGES: z.coerce.number().int().default(100),
    MAX_OUTPUT_TOKENS: z.coerce.number().int().default(4096),
    MCP_ALLOW_WRITES: bool.default('false'),
  })
  .superRefine((v, ctx) => {
    if (v.EMBEDDINGS === 'openai' && v.FREE_ONLY) {
      ctx.addIssue({ code: 'custom', path: ['EMBEDDINGS'], message: 'openai embeddings are a paid API: blocked while FREE_ONLY=true (use local or ollama)' });
    }
    if (v.EMBEDDINGS === 'openai' && !v.OPENAI_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['OPENAI_API_KEY'], message: 'required when EMBEDDINGS=openai' });
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid configuration:');
  for (const i of parsed.error.issues) console.error(`  - ${i.path.join('.')}: ${i.message}`);
  process.exit(1);
}

export const config = Object.freeze(parsed.data);
