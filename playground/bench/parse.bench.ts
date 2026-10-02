import { bench, describe } from "@lightning-js/lightning";

describe.bench("JSON", () => {
  bench("parse", () => { JSON.parse('{"answer":42}'); }, { time: 20, iterations: 10, warmup: false });
  bench.skip("expensive parse", () => { throw new Error("skipped benchmark executed"); });
});
