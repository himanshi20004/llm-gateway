import './mcpStderr.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config } from '../config/config.js';
import { connectMongo } from '../lib/mongo.js';
import { CATALOG } from '../config/catalog.js';
import { CHAINS, assertProviders } from '../config/chains.js';
import { explainRouting } from '../core/plan.js';
import * as svc from './admin.js';
import { logger } from '../lib/logger.js';

// Least privilege: read-only tools are always on; the single write tool only exists when MCP_ALLOW_WRITES=true.
// Note: tool results contain tenant-supplied strings (names). Clients must treat them as untrusted data.
const ok = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
const fail = (m) => ({ isError: true, content: [{ type: 'text', text: m }] });
const TenantId = z.string().regex(/^[a-f0-9]{24}$/, 'tenantId must be a 24-char hex id');

const server = new McpServer({ name: 'llm-gateway-admin', version: '1.0.0' });

server.tool('list_models', 'List routing tiers and the available fallback chain for each.', async () =>
  ok(Object.fromEntries(Object.entries(CHAINS).map(([t, c]) => [t, c.map((m) => ({ id: m.id, inPerM: m.inPerM, outPerM: m.outPerM }))]))));

server.tool('explain_routing', 'Dry-run the router: which tier and fallback chain a prompt would get and why. Nothing is stored or sent to a model.',
  { prompt: z.string().min(1).max(20_000) },
  async ({ prompt }) => ok(await explainRouting([{ role: 'user', content: prompt }])));

server.tool('tenant_usage', 'Spend, savings vs all-premium baseline, cache hit rate and TTFT percentiles.',
  { tenantId: TenantId.optional(), days: z.number().int().min(1).max(90).default(7) },
  async (a) => ok(await svc.usageSummary(a)));

server.tool('tenant_spend', "A tenant's spend so far this month (USD).", { tenantId: TenantId },
  async ({ tenantId }) => ok({ tenantId, spentUsd: await svc.tenantSpend(tenantId) }));

server.tool('top_spenders', 'Tenants ranked by spend.',
  { days: z.number().int().min(1).max(90).default(7), limit: z.number().int().min(1).max(20).default(5) },
  async (a) => ok(await svc.topSpenders(a)));

if (config.MCP_ALLOW_WRITES) {
  server.tool('set_tenant_budget', 'WRITE: change a tenant monthly budget. Requires confirm=true and a cap of 10000 USD.',
    { tenantId: TenantId, monthlyBudgetUsd: z.number().min(0).max(10_000), confirm: z.literal(true) },
    async ({ tenantId, monthlyBudgetUsd }) => {
      const t = await svc.updateTenant(tenantId, { monthlyBudgetUsd });
      logger.warn({ tenantId, monthlyBudgetUsd }, 'MCP budget change'); // audit trail
      return t ? ok(t) : fail('Tenant not found.');
    });
}

assertProviders();
await connectMongo();
await server.connect(new StdioServerTransport());
logger.info({ models: Object.keys(CATALOG).length, writes: config.MCP_ALLOW_WRITES }, 'MCP server ready');
