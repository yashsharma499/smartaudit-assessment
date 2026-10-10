export const VECTOR_DIMENSIONS = 8;
export const HASH_VECTOR_MODEL = 'hash-8d-v1';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'of', 'on',
  'or', 'the', 'this', 'to', 'was', 'were', 'with', 'without',
]);

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9$ ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** 32-bit FNV-1a hash. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function l2Normalize(vec) {
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return vec.map(() => 0);
  return vec.map((x) => x / norm);
}

/**
 * Deterministic "mock embedding": signed feature hashing of the description's
 * tokens and bigrams into 8 buckets, then L2-normalised.
 * Texts that share vocabulary land close together, so cosine similarity is meaningful
 * (unlike random vectors). The sign bit spreads tokens across +/- so unrelated texts
 * don't all point into the same positive orthant.
 */
export function hashEmbedding(text, dims = VECTOR_DIMENSIONS) {
  const tokens = tokenize(text);
  const features = [...tokens];
  for (let i = 0; i < tokens.length - 1; i += 1) features.push(`${tokens[i]}_${tokens[i + 1]}`);

  const vec = new Array(dims).fill(0);
  for (const f of features) {
    const h = fnv1a(f);
    const bucket = h % dims;
    const sign = (h >>> 31) === 1 ? -1 : 1;
    vec[bucket] += sign;
  }
  return l2Normalize(vec).map((x) => Number(x.toFixed(4)));
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Returns the k candidates most similar to `target`, highest first.
 * Uses a bounded insertion list (O(n·k)) instead of sorting the whole candidate set.
 */
export function topKSimilar(target, candidates, k = 3, getVector = (c) => c.vector) {
  const best = [];
  for (const c of candidates) {
    const score = cosineSimilarity(target, getVector(c));
    if (best.length < k || score > best[best.length - 1].score) {
      best.push({ item: c, score });
      best.sort((x, y) => y.score - x.score);
      if (best.length > k) best.pop();
    }
  }
  return best;
}
