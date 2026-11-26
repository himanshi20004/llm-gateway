import Redis from 'ioredis';
import { config } from '../config/config.js';
import { logger } from './logger.js';

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 2000 });
redis.on('error', (e) => logger.error({ err: e.message }, 'redis error'));

// Token bucket. Time comes from Redis (TIME), never from the client, so app-server clock skew is irrelevant.
// ARGV: capacity, refill/sec, cost. Returns {allowed, tokensLeft}.
redis.defineCommand('tokenBucket', {
  numberOfKeys: 1,
  lua: `
    local t = redis.call('TIME')
    local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
    local cap, refill, cost = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
    local d = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
    local tokens, ts = tonumber(d[1]), tonumber(d[2])
    if tokens == nil then tokens = cap; ts = now end
    tokens = math.min(cap, tokens + math.max(0, now - ts) / 1000 * refill)
    local ok = 0
    if tokens >= cost then tokens = tokens - cost; ok = 1 end
    redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
    redis.call('PEXPIRE', KEYS[1], math.ceil(cap / refill * 2000))
    return {ok, tostring(tokens)}
  `,
});

// Atomically reserve estimated cost against the monthly budget (check + increment in one step, no race).
// ARGV: estimate, limit, ttl seconds. Returns {reserved, spentAfter}.
redis.defineCommand('budgetReserve', {
  numberOfKeys: 1,
  lua: `
    local spent = tonumber(redis.call('GET', KEYS[1]) or '0')
    local est, limit = tonumber(ARGV[1]), tonumber(ARGV[2])
    if spent + est > limit then return {0, tostring(spent)} end
    local after = redis.call('INCRBY', KEYS[1], est)
    if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3])) end
    return {1, tostring(after)}
  `,
});

// Settle reservation against actual cost (delta may be negative). Never lets the counter go below zero.
redis.defineCommand('budgetSettle', {
  numberOfKeys: 1,
  lua: `
    local v = redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))
    if v < 0 then redis.call('SET', KEYS[1], 0) end
    return v
  `,
});
