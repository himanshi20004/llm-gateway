import mongoose from 'mongoose';
import { connectMongo } from '../src/lib/mongo.js';
import { redis } from '../src/lib/redis.js';
import * as svc from '../src/services/admin.js';

await connectMongo();
const name = process.argv[2] || `demo-${Date.now().toString(36)}`;
const budget = Number(process.argv[3] || 5);
const tenant = await svc.createTenant({ name, monthlyBudgetUsd: budget, rpm: 600 });
const key = await svc.createKey(tenant.id, 'seed');
console.log(`\nTenant: ${tenant.name} (${tenant.id}), budget $${budget}\nAPI key (shown once):\n  ${key.apiKey}\n`);
console.log(`Try:\n  curl -N localhost:8080/v1/chat/completions -H "Authorization: Bearer ${key.apiKey}" -H "content-type: application/json" \\\n    -d '{"messages":[{"role":"user","content":"What is the capital of France?"}],"stream":true}'\n`);
await mongoose.disconnect();
await redis.quit();
