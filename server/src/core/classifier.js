// Pure and dependency-free. Returns a score in [0,1] plus human-readable reasons,
// so every routing decision can be explained (and audited) after the fact.
const RX = {
  code: /```|\b(function|class|def|import|SELECT|const|let|var|#include)\b|=>/,
  heavy: /\b(prove|derive|step[- ]by[- ]step|architecture|design (a|an|the)|optimi[sz]e|trade-?offs?|refactor|debug|root cause|analy[sz]e|compare and contrast|algorithm|complexity|rigorous|migration plan)\b/i,
  light: /\b(translate|summari[sz]e|define|spell|rephrase|fix (the )?grammar|classify|extract|tl;?dr|what is|who is|capital of|synonym)\b/i,
  math: /[∑∫√≤≥]|\b\d+\s*[\^*/]\s*\d+|\b(integral|derivative|theorem|equation)\b/i,
};

const clamp = (x) => Math.max(0, Math.min(1, x));
export const lastUser = (messages) => [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

export function heuristicScore(messages, { maxTokens } = {}) {
  const last = lastUser(messages);
  const all = messages.map((m) => m.content).join('\n');
  const reasons = [];
  let s = 0.15;

  const hasCode = RX.code.test(all);
  if (last.length > 2000) { s += 0.25; reasons.push('long_prompt'); }
  else if (last.length > 600) { s += 0.12; reasons.push('medium_prompt'); }
  else if (last.length < 120 && !hasCode) { s -= 0.08; reasons.push('short_prompt'); }

  if (all.length > 12000) { s += 0.15; reasons.push('large_context'); }
  if (hasCode) { s += 0.25; reasons.push('code'); }
  // Each distinct reasoning cue adds weight (first 0.25, then 0.12 each, capped at 3 cues).
  const cues = new Set([...last.matchAll(new RegExp(RX.heavy.source, 'gi'))].map((m) => m[0].toLowerCase()));
  if (cues.size) { s += 0.25 + 0.12 * Math.min(cues.size - 1, 2); reasons.push(`reasoning_cues:${cues.size}`); }
  if (RX.math.test(last)) { s += 0.15; reasons.push('math'); }
  if (RX.light.test(last) && last.length < 800) { s -= 0.12; reasons.push('simple_task_cue'); }
  if (messages.filter((m) => m.role === 'user').length > 6) { s += 0.08; reasons.push('long_conversation'); }
  if (maxTokens && maxTokens > 2000) { s += 0.1; reasons.push('long_output_requested'); }

  return { score: clamp(s), reasons };
}

export const THRESHOLDS = { cheap: 0.32, mid: 0.62 };
export const tierFromScore = (score, t = THRESHOLDS) => (score < t.cheap ? 'cheap' : score < t.mid ? 'mid' : 'premium');

/** Blend heuristic and embedding-kNN scores. kNN only counts when the nearest exemplar is actually close. */
export function blend(h, knn) {
  if (!knn || knn.topSim < 0.35) return { score: h.score, reasons: h.reasons };
  return {
    score: clamp(0.65 * h.score + 0.35 * knn.score),
    reasons: [...h.reasons, `knn:${knn.score.toFixed(2)}@${knn.topSim.toFixed(2)}`],
  };
}
