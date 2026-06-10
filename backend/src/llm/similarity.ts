/** Sørensen–Dice bigram similarity (0..1). No DB extension required. */
export function diceSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const bigrams = (s: string) => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      map.set(bg, (map.get(bg) ?? 0) + 1);
    }
    return map;
  };
  const ma = bigrams(na);
  const mb = bigrams(nb);
  let overlap = 0;
  for (const [bg, count] of ma) overlap += Math.min(count, mb.get(bg) ?? 0);
  return (2 * overlap) / (na.length - 1 + nb.length - 1);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Find the most similar string in a list above a threshold, or null. */
export function mostSimilar(needle: string, haystack: string[], threshold: number): string | null {
  let best: string | null = null;
  let bestScore = threshold;
  for (const candidate of haystack) {
    const score = diceSimilarity(needle, candidate);
    if (score >= bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}
