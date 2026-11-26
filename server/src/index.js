import mongoose from 'mongoose';
import { config } from './config/config.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { connectMongo } from './lib/mongo.js';
import { assertProviders } from './config/chains.js';
import { buildApp } from './app.js';

assertProviders();
await connectMongo();
await redis.ping();

const server = buildApp().listen(config.PORT, () => logger.info({ port: config.PORT, env: config.NODE_ENV }, 'gateway listening'));
server.keepAliveTimeout = 65_000; // above typical load-balancer idle timeouts
server.headersTimeout = 66_000;

let closing = false;
async function shutdown(sig) {
  if (closing) return;
  closing = true;
  logger.info({ sig }, 'draining');
  setTimeout(() => process.exit(1), 25_000).unref(); // hard stop if streams never finish
  server.close(async () => {
    await Promise.allSettled([mongoose.disconnect(), redis.quit()]);
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => logger.error({ err: String(e) }, 'unhandledRejection'));
