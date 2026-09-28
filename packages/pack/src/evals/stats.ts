function logFactorials(n: number): number[] {
  const out = [0];
  for (let i = 1; i <= n; i++) out.push(out[i - 1]! + Math.log(i));
  return out;
}

/**
 * One-sided Fisher's exact test that the candidate's rate is lower than the
 * no-pack rate. Returns the p-value: the chance of a candidate result this
 * low or lower if the pack made no difference.
 */
export function fisherLower(candidateSuccesses: number, candidateTrials: number, baselineSuccesses: number, baselineTrials: number): number {
  const N = candidateTrials + baselineTrials;
  const K = candidateSuccesses + baselineSuccesses;
  const n = candidateTrials;
  if (N === 0 || n === 0 || baselineTrials === 0) return 1;
  const lf = logFactorials(N);
  const logChoose = (a: number, b: number) => lf[a]! - lf[b]! - lf[a - b]!;
  const denom = logChoose(N, n);
  let p = 0;
  const lo = Math.max(0, n - (N - K));
  for (let x = lo; x <= candidateSuccesses; x++) {
    if (x > K || n - x > N - K) continue;
    p += Math.exp(logChoose(K, x) + logChoose(N - K, n - x) - denom);
  }
  return Math.min(1, p);
}

export function rate(successes: number, trials: number): number {
  return trials === 0 ? 0 : Math.round((successes / trials) * 100) / 100;
}

export function percent(successes: number, trials: number): string {
  return trials === 0 ? "n/a" : `${Math.round((successes / trials) * 100)}% (${successes}/${trials})`;
}
