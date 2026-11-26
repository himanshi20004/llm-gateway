// Offline "feature hashing" embedder: word unigrams, bigrams and char trigrams hashed into 256 signed
// buckets. It is NOT a semantic model: it catches near-duplicates (case, punctuation, small edits).
// Use EMBEDDINGS=openai for real semantic similarity.
const DIM = 256;

function fnv(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export function localEmbed(text) {
  const v = new Float32Array(DIM);
  const words = text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const feats = [];
  for (let i = 0; i < words.length; i++) {
    feats.push('w:' + words[i]);
    if (i + 1 < words.length) feats.push('b:' + words[i] + ' ' + words[i + 1]);
    const p = `^${words[i]}$`;
    for (let j = 0; j <= p.length - 3; j++) feats.push('c:' + p.slice(j, j + 3));
  }
  for (const f of feats) v[fnv(f) % DIM] += fnv(f, 0x9747b28c) & 1 ? 1 : -1;
  return normalize(v);
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export const encodeVec = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
export function decodeVec(s) {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
