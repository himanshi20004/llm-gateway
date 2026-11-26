# Cost-Aware LLM Gateway

An OpenAI-compatible gateway that sits between your apps and LLM providers and enforces **per-tenant budgets**, **routes each prompt to the cheapest model that can handle it**, **caches answers safely**, and **survives slow or failing providers** with hedged requests and circuit breakers.

Stack: Node.js + Express, MongoDB (Mongoose), Redis (Lua), React dashboard. LangChain provider adapters, a LangGraph decision pipeline, and an MCP server (+ a LangGraph FinOps agent that uses it).

## Architecture

```
client ─► Express ─► auth (HMAC key) ─► tenant rate limit (Redis token bucket)
                       │
                       ▼   LangGraph decision pipeline
                 guard ─► exact cache ─► embed + semantic cache ─► classify ─► budget reserve (Redis Lua)
                   │          │ hit            │ hit                  │             │ reject 402
                   ▼          ▼                ▼                      ▼             ▼
                reject 400   serve from cache (encrypted, per tenant)      chain of models for the tier
                                                                                │
                                          hedgedStream: failover + hedge + idle timeout + circuit breakers
                                                                                │
                                   SSE / JSON ◄── LangChain provider (Anthropic / OpenAI / mock)
                                                                                │
                              finalize (async): settle budget · usage log · cache write · cache audit
```

| Path | Role |
|---|---|
| `server/src/graph/plan.js` | LangGraph state machine (guard → cache → classify → budget) |
| `server/src/router/hedge.js` | Hedged requests, failover, idle timeout (dependency-free, unit tested) |
| `server/src/router/classifier.js`, `knn.js` | Explainable complexity scoring + embedding kNN |
| `server/src/lib/redis.js` | Lua: token bucket, atomic budget reserve/settle |
| `server/src/cache/semanticCache.js` | Per-tenant AES-256-GCM encrypted exact + semantic cache |
| `server/src/mcp/server.js` | MCP tools (read-only by default) |
| `server/src/agent/finops.js` | LangGraph ReAct agent over the MCP tools |
| `web/` | React console: tenants, usage, streaming playground |

## Zero-cost setup (everything free)

Nothing here needs a paid account or a credit card.

| Piece | Free choice | Notes |
|---|---|---|
| LLMs | **Groq free plan** (hosted, fast), **Ollama** (local), or the built-in mock | Paid APIs are blocked while `FREE_ONLY=true` |
| Database | MongoDB 7 in Docker | Community edition, free |
| Cache / limits | Redis 7 in Docker | Free to self-host |
| Embeddings | Built-in hashing (`local`) or `nomic-embed-text` via Ollama | Groq has no embeddings API |
| Frontend / tooling | Node.js, Vite, React | Open source |
| Hosting | Your own laptop | No cloud needed |

**Fallback order:** Groq first (fast), then local Ollama if enabled. A Groq rate-limit (HTTP 429) or outage fails over automatically, which is exactly what the circuit breaker and failover chain are for.

**How the guard works:** `FREE_ONLY=true` is the default. Anthropic and OpenAI models are removed from every fallback chain at startup, pinned requests for them are rejected, `EMBEDDINGS=openai` fails config validation, and the FinOps agent only uses Groq or local models.

**Groq caveats (read these):**
- Groq is free only while your account stays on the free plan. Code cannot verify that, so never add billing or upgrade the account.
- Free-tier limits and model ids change without notice. Check https://console.groq.com/docs/models and edit `GROQ_MODEL_*` if a model is retired.
- Prompts sent through Groq leave your machine. For private data use Ollama only (leave `GROQ_API_KEY` empty).

**Ollama hardware:** `llama3.2:3b` needs about 2-3 GB RAM and `qwen2.5:7b` about 5-6 GB. CPU-only works, just slowly.

Costs shown in the console are **notional**: free models cost $0, so `catalog.js` assigns pretend prices to make budgets and "savings vs premium" demonstrable.

## Quickstart

Prerequisites (all free): Node.js 20+, Docker Desktop (or Docker Engine), and a free Groq key and/or [Ollama](https://ollama.com).

```bash
# 1. Server
cd server
npm install
npm run setup               # creates ../.env with generated secrets, prints your admin key
#    then edit ../.env: paste GROQ_API_KEY=... (and/or set ENABLE_OLLAMA=true after `ollama pull ...`)
docker compose -f ../docker-compose.yml up -d mongo redis
npm run seed                # creates a demo tenant, prints its API key ONCE
npm run dev                 # http://localhost:8080

# 2. Dashboard (second terminal)
cd web && npm install && npm run dev     # http://localhost:5173, sign in with the admin key
```

No key and no Ollama? Leave both off and the built-in mock provider runs automatically in development.

Use it from any OpenAI SDK by changing only the base URL:

```js
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'http://localhost:8080/v1', apiKey: 'gw_...' });
const r = await client.chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: 'Hi' }] });
```

`model` can be `auto`, a tier (`cheap|mid|premium`), or a catalog id. Response headers show the decision: `x-gateway-tier`, `x-gateway-model`, `x-gateway-cache`, `x-gateway-hedged`, `server-timing`. Send `x-gateway-no-cache: 1` to bypass the cache.

Not supported (by design, to keep the surface small): tool calls, multimodal content arrays, `n > 1`. Unknown fields are ignored.

## Demo the resilience features (mock provider)

```bash
ENABLE_OLLAMA=false ENABLE_MOCK=true MOCK_SLOW_MODELS=mock:cheap MOCK_FIRST_TOKEN_MS=6000 HEDGE_AFTER_MS=800 npm run dev   # first token slow -> hedge wins
ENABLE_OLLAMA=false ENABLE_MOCK=true MOCK_FAIL_MODELS=mock:cheap npm run dev                                                 # 503s -> failover, breaker opens
```

## Security model

| Threat | Control | Where |
|---|---|---|
| Stolen database leaks API keys | Only an HMAC-SHA256 (with server pepper) of the 256-bit secret is stored; plaintext shown once | `lib/crypto.js`, `services/admin.js` |
| Key guessing / timing attacks | Constant-time compare, hash computed even for unknown key ids, per-IP limit on the auth path | `middleware/auth.js` |
| Weak or missing secrets | Zod-validated config; process exits on bad secrets | `config.js` |
| NoSQL injection | zod validation + `sanitizeFilter` + ObjectId regex | `db/mongo.js`, `routes/admin.js` |
| Prototype pollution via `model` | `Object.hasOwn` allowlist, never `in` | `config/chains.js` |
| Runaway spend | Atomic budget reservation priced at the dearest fallback, settled to actuals; per-tenant max tier; **fail closed** if Redis is down | `lib/redis.js`, `graph/plan.js` |
| Cross-tenant cache leakage / poisoning | Tenant-namespaced keys, AES-GCM with tenant AAD, context-hash match (same system prompt/history), only successful completions cached | `cache/semanticCache.js` |
| PII in cache or logs | Sensitive prompts never cached; usage logs hold only a prompt hash and counters | `security/guard.js`, `models/index.js` |
| Wrong cached answer | Per-route threshold, `x-gateway-no-cache`, shadow audit of sampled hits | `services/finalize.js` |
| Abuse / oversized input | Body limit, message/length caps, zod schemas, per-tenant RPM | `app.js`, `routes/chat.js` |
| Provider error leakage | Generic client errors, details only in server logs | `routes/chat.js` |
| CORS / clickjacking / sniffing | Origin allowlist, helmet defaults | `app.js` |
| Prompt injection into the ops agent | Read-only tool allowlist, MCP writes off by default, confirm flag + cap on the one write tool | `mcp/server.js`, `agent/finops.js` |
| Container compromise | Non-root, read-only FS, dropped capabilities, infra bound to localhost | `Dockerfile`, `docker-compose.yml` |

## Benchmarking (for your resume numbers)

```bash
# Gateway overhead: mock provider with zero latency
ENABLE_MOCK=true MOCK_BASE_MS=0 MOCK_TOKEN_MS=0 npm start
GATEWAY_KEY=gw_... npm run bench -- http://localhost:8080 2000 50
GATEWAY_KEY=gw_... npm run bench -- http://localhost:8080 2000 50 --cache     # cache-hit path
```

Savings: the console's Usage tab compares real spend with an all-premium baseline for the same tokens. For an honest "answer-equivalence" number, replay a labelled prompt set through `auto` and a premium-only run and score agreement. Do not publish a figure you cannot reproduce.

## Known limitations (and what to do next)

- **Prices are notional.** Local models cost $0; the catalog prices only make budgets and savings demonstrable. If you ever turn `FREE_ONLY` off, replace paid-model prices and ids with the providers' real ones.
- **Hashing embedder is lexical.** It catches near-duplicates only. Use `EMBEDDINGS=openai` for semantic matching, and tune `CACHE_THRESHOLD` against your own data.
- **Cache search is a bounded linear scan** (50 entries per context). At scale use Atlas Vector Search or RediSearch HNSW.
- **No mid-stream failover.** Once tokens reach the client, a failure is surfaced as an SSE error event.
- **Redis is the budget source of truth;** if it is wiped, rebuild counters from `UsageLog`. A reconciliation job is not included.
- **Per-instance state:** circuit breakers and the auth cache are in-process; IP rate limits use the in-memory store (use `rate-limit-redis` for multiple instances).
- Dashboard needs a real CSP and TLS from your reverse proxy in production; admin auth is a single shared key. Replace with SSO/RBAC for real use.
- Verified here: the free-only provider filtering (Groq, Ollama, mock and paid-key configurations), the setup script, unit tests for hedging, breakers, classifier, crypto and embeddings pass, and every server file passes a syntax check. The full stack (Mongo, Redis, LangChain, LangGraph, MCP, React) was **not** run end to end in the authoring sandbox because it had no network for `npm install`. Pin dependency versions after your first install and run it once before relying on it.
