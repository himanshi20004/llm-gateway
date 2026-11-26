import { Router } from 'express';
import { z } from 'zod';
import { TIERS } from '../config/catalog.js';
import { sendError } from '../lib/http.js';
import * as svc from '../services/admin.js';

export const adminRouter = Router();

const Id = z.string().regex(/^[a-f0-9]{24}$/);
const Usd = z.number().min(0).max(1_000_000);
const CreateTenant = z.object({ name: z.string().trim().min(1).max(80), monthlyBudgetUsd: Usd, rpm: z.number().int().min(1).max(100_000).optional(), maxTier: z.enum(TIERS).optional() }).strict();
const PatchTenant = z.object({ monthlyBudgetUsd: Usd, rpm: z.number().int().min(1).max(100_000), status: z.enum(['active', 'suspended']), maxTier: z.enum(TIERS), cacheEnabled: z.boolean() }).partial().strict();

const bad = (req, res, e) => sendError(res, req, 400, 'invalid_request', e.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
const wrap = (fn) => (req, res, next) => fn(req, res).catch((e) => (e.code === 11000 ? sendError(res, req, 409, 'conflict', 'Already exists.') : next(e)));

adminRouter.get('/tenants', wrap(async (req, res) => res.json({ data: await svc.listTenants() })));

adminRouter.post('/tenants', wrap(async (req, res) => {
  const p = CreateTenant.safeParse(req.body);
  if (!p.success) return bad(req, res, p.error);
  res.status(201).json(await svc.createTenant(p.data));
}));

adminRouter.patch('/tenants/:id', wrap(async (req, res) => {
  const id = Id.safeParse(req.params.id);
  const p = PatchTenant.safeParse(req.body);
  if (!id.success || !p.success) return bad(req, res, (id.error ?? p.error));
  const t = await svc.updateTenant(id.data, p.data);
  return t ? res.json(t) : sendError(res, req, 404, 'not_found', 'Tenant not found.');
}));

adminRouter.post('/tenants/:id/keys', wrap(async (req, res) => {
  const id = Id.safeParse(req.params.id);
  const p = z.object({ label: z.string().max(80).optional() }).strict().safeParse(req.body ?? {});
  if (!id.success || !p.success) return bad(req, res, (id.error ?? p.error));
  const k = await svc.createKey(id.data, p.data.label);
  if (!k) return sendError(res, req, 404, 'not_found', 'Tenant not found.');
  res.set('Cache-Control', 'no-store').status(201).json({ ...k, note: 'Store this key now. It cannot be shown again.' });
}));

adminRouter.delete('/keys/:keyId', wrap(async (req, res) => {
  const k = z.string().regex(/^[0-9a-f]{12}$/).safeParse(req.params.keyId);
  if (!k.success) return bad(req, res, k.error);
  return (await svc.revokeKey(k.data)) ? res.status(204).end() : sendError(res, req, 404, 'not_found', 'Key not found or already revoked.');
}));

adminRouter.get('/usage', wrap(async (req, res) => {
  const q = z.object({ tenantId: Id.optional(), days: z.coerce.number().int().min(1).max(90).default(7) }).safeParse(req.query);
  if (!q.success) return bad(req, res, q.error);
  res.json(await svc.usageSummary(q.data));
}));
