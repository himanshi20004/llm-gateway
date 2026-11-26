import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import mongoose from 'mongoose';
import { config } from './config/config.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { sendError } from './lib/http.js';
import { adminAuth } from './routes/auth.js';
import { chatRouter } from './routes/chat.js';
import { adminRouter } from './routes/admin.js';

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY); // set only when behind a known proxy, else X-Forwarded-For is spoofable

  app.use(helmet());
  const origins = config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({
    origin: (o, cb) => cb(null, !o || origins.includes(o)), // allowlist, never "*"
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization', 'x-admin-key', 'x-gateway-no-cache'],
    exposedHeaders: ['x-request-id', 'x-gateway-tier', 'x-gateway-model', 'x-gateway-cache', 'x-gateway-hedged', 'server-timing'],
    maxAge: 600,
  }));
  app.use(pinoHttp({
    logger,
    genReqId: (req, res) => { const id = crypto.randomUUID(); res.setHeader('x-request-id', id); return id; },
    serializers: { req: (r) => ({ id: r.id, method: r.method, url: r.url.split('?')[0] }) }, // no headers, no query strings
  }));
  app.use(express.json({ limit: `${config.MAX_BODY_KB}kb` }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/readyz', async (_req, res) => {
    const ok = mongoose.connection.readyState === 1 && (await redis.ping().then(() => true, () => false));
    res.status(ok ? 200 : 503).json({ ok });
  });

  // Coarse per-IP limits protect the auth path itself; per-tenant limits run after authentication.
  const ipLimit = (limit) => rateLimit({ windowMs: 60_000, limit, standardHeaders: 'draft-7', legacyHeaders: false });
  app.use('/v1', ipLimit(600), chatRouter);
  app.use('/admin', ipLimit(60), adminAuth, adminRouter);

  app.use((req, res) => sendError(res, req, 404, 'not_found', 'Not found.'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.too.large') return sendError(res, req, 413, 'payload_too_large', 'Request body too large.');
    if (err.type === 'entity.parse.failed') return sendError(res, req, 400, 'invalid_json', 'Malformed JSON.');
    req.log.error({ err: err.message, stack: config.NODE_ENV === 'production' ? undefined : err.stack }, 'unhandled error');
    sendError(res, req, 500, 'internal_error', 'Internal error.'); // generic: never leak internals
  });
  return app;
}
