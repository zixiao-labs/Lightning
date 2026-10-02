import { test, expect } from "@lightning-js/lightning";
import { bench, describeBench, startBenchmarkCollection, finishBenchmarkCollection } from "../src/bench/index.ts";
import { benchmarkRegression, measureBenchmark } from "../src/bench/runner.ts";
import { createBenchmarkContext } from "../src/bench/context.ts";
import { runBenchmarks } from "../src/bench/runner.ts";
import type { ResolvedLightningConfig } from "../src/types.ts";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

test("benchmark collector inherits skip and only with nested names", () => {
  startBenchmarkCollection();
  describeBench.only("group", () => {
    bench("selected", () => {});
    describeBench.skip("ignored", () => bench.only("nested", () => {}));
  });
  const tasks = finishBenchmarkCollection();
  expect(tasks.map(({ name, mode }) => ({ name, mode }))).toEqual([
    { name: "group > selected", mode: "only" },
    { name: "group > ignored > nested", mode: "skip" },
  ]);
});

test("regression threshold is a percentage and permits exact boundary", () => {
  expect(benchmarkRegression(90, 100, 10)).toBeUndefined();
  expect(benchmarkRegression(89, 100, 10)).toContain("regression");
  expect(benchmarkRegression(100, 0, 10)).toContain("Baseline");
});

test("Tinybench measurement returns throughput and sample statistics", async () => {
  const stats = await measureBenchmark({ name: "parse", mode: "run", fn: () => { JSON.parse("{}"); }, options: { time: 2, iterations: 3, warmup: false } });
  expect(stats.hz).toBeGreaterThan(0);
  expect(stats.samples).toBeGreaterThan(0);
});

test("context bench supports run and serial comparison", async () => {
  const fixture = createBenchmarkContext();
  const options = { time: 2, iterations: 3, warmup: false };
  const result = await fixture.compare(
    fixture("a", options, () => { JSON.parse("{}"); }),
    fixture("b", () => { JSON.parse("[]"); }, options),
  );
  expect(result.get("a")!.throughput.mean).toBeGreaterThan(0);
  expect(result.get("b")!.latency.mean).toBeGreaterThan(0);
});

test("benchmark runner imports serial tasks and writes and compares JSON baselines", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lightning-bench-"));
  try {
    const config = { root: process.cwd(), nasti: { root: process.cwd() } } as ResolvedLightningConfig;
    const fixture = path.resolve(config.root, "test/fixtures/bench/serial.bench.ts");
    const baseline = path.join(temp, "baseline.json");
    const initial = await runBenchmarks([fixture], config, { baseline });
    expect(initial[0]!.error).toBeUndefined();
    expect(initial[0]!.results.map((result) => result.state)).toEqual(["pass", "pass", "skip"]);
    const stored = JSON.parse(await readFile(baseline, "utf8"));
    expect(Object.keys(stored.benchmarks).length).toBe(2);
    // A deliberately impossible historical throughput makes comparison
    // deterministic despite normal timing noise on the host machine.
    for (const stats of Object.values(stored.benchmarks) as { hz: number }[]) stats.hz = Number.MAX_VALUE;
    await writeFile(baseline, JSON.stringify(stored));
    const compared = await runBenchmarks([fixture], config, { compare: baseline, threshold: 10 });
    expect(compared[0]!.results[0]!.state).toBe("fail");
    expect(compared[0]!.results[0]!.error!.message).toContain("regression");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 15000);
