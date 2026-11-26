import { cosine } from './embeddings.js';

export const TIER_VALUE = { cheap: 0.1, mid: 0.5, premium: 0.9 };

export const EXEMPLARS = [
  ['cheap', "Translate 'good morning' to French"],
  ['cheap', 'Summarize this paragraph in one sentence'],
  ['cheap', 'What is the capital of Australia?'],
  ['cheap', 'Fix the grammar in this sentence'],
  ['cheap', 'Classify this review as positive or negative'],
  ['cheap', 'Extract the email addresses from this text'],
  ['mid', 'Write a Python function that merges two sorted lists and add unit tests'],
  ['mid', 'Explain the difference between TCP and UDP with examples'],
  ['mid', 'Draft a polite email declining a vendor proposal and suggesting next steps'],
  ['mid', 'Convert this SQL query to use window functions'],
  ['premium', 'Design a multi-region architecture for a payment system with exactly-once semantics and explain the trade-offs'],
  ['premium', 'Prove the algorithm is correct and derive its worst-case complexity'],
  ['premium', 'Find the root cause of this race condition across three services and propose a refactor'],
  ['premium', 'Analyze this contract clause for legal risks and compare alternatives'],
].map(([tier, text]) => ({ tier, text }));

/** Similarity-weighted average of the k nearest exemplars' tier values. */
export function knnScore(vec, bank, k = 3) {
  const top = bank
    .map((e) => ({ s: cosine(vec, e.vec), v: TIER_VALUE[e.tier] }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k);
  const w = top.reduce((a, x) => a + Math.max(x.s, 0), 0);
  if (w < 0.01) return null;
  return { score: top.reduce((a, x) => a + Math.max(x.s, 0) * x.v, 0) / w, topSim: top[0].s };
}
