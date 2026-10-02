/** Browser-safe counter lifecycle. Keep objects alive for warm module closures. */
interface Counters {
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
  [key: string]: unknown;
}
const host = globalThis as typeof globalThis & { __lightning_coverage__?: Record<string, Counters> };

export function startIstanbulCoverage(): void {
  for (const counters of Object.values(host.__lightning_coverage__ ?? {})) {
    for (const key of Object.keys(counters.s)) counters.s[key] = 0;
    for (const key of Object.keys(counters.f)) counters.f[key] = 0;
    for (const values of Object.values(counters.b)) values.fill(0);
  }
}

export function finishIstanbulCoverage(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(host.__lightning_coverage__ ?? {}));
}
