import { bench } from "../../../src/bench/index.ts";

let active = false;
for (const name of ["first", "second"]) {
  bench(name, async () => {
    if (active) throw new Error("Benchmarks overlapped");
    active = true;
    await new Promise((resolve) => setTimeout(resolve, 1));
    active = false;
  }, { time: 2, iterations: 3, warmup: false });
}
bench.skip("skipped", () => { throw new Error("Skip was ignored"); });
