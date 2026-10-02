import { test, expect } from "@lightning-js/lightning";
import { bench, describeBench, startBenchmarkCollection, finishBenchmarkCollection } from "../src/bench/index.ts";
import { benchmarkRegression, measureBenchmark } from "../src/bench/runner.ts";
import { createBenchmarkContext } from "../src/bench/context.ts";
import { runBenchmarks } from "../src/bench/runner.ts";
import { runBenchmarkTests } from "../src/node/orchestrator.ts";
import type { ResolvedLightningConfig } from "../src/types.ts";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
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

test("benchmark runner imports serial tasks and returns entries for comparison", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lightning-bench-"));
  try {
    const config = { root: process.cwd(), nasti: { root: process.cwd() } } as ResolvedLightningConfig;
    const fixture = path.resolve(config.root, "test/fixtures/bench/serial.bench.ts");
    const initial = await runBenchmarks([fixture], config);
    expect(initial.files[0]!.error).toBeUndefined();
    expect(initial.files[0]!.results.map((result) => result.state)).toEqual(["pass", "pass", "skip"]);
    const stored = { version: 1 as const, benchmarks: initial.benchmarks };
    expect(Object.keys(stored.benchmarks).length).toBe(2);
    // A deliberately impossible historical throughput makes comparison
    // deterministic despite normal timing noise on the host machine.
    for (const stats of Object.values(stored.benchmarks) as { hz: number }[]) stats.hz = Number.MAX_VALUE;
    const compared = await runBenchmarks([fixture], config, { baseline: stored, threshold: 10 });
    expect(compared.files[0]!.results[0]!.state).toBe("fail");
    expect(compared.files[0]!.results[0]!.error!.message).toContain("regression");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 15000);

test("benchmark baselines merge projects at the root and survive comparison and execution failures", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lightning-bench-projects-"));
  try {
    for (const name of ["a", "b"]) {
      await mkdir(path.join(temp, name));
      await writeFile(path.join(temp, name, "sample.bench.js"),
        'bench("sample", () => {}, { time: 2, iterations: 3, warmup: false });\n');
    }
    const config = path.join(temp, "lightning.config.mjs");
    await writeFile(config, `export default ${JSON.stringify({
      root: temp,
      test: { globals: true, reporters: [{}], projects: [
        { name: "a", root: path.join(temp, "a") },
        { name: "b", root: path.join(temp, "b") },
      ] },
    })};\n`);
    const options = { config, benchmarkBaseline: "baselines/merged.json" };
    const initial = await runBenchmarkTests(options);
    expect(initial.files.length).toBe(2);
    expect(initial.files.map((file) => file.results[0]!.state)).toEqual(["pass", "pass"]);
    const target = path.join(temp, "baselines/merged.json");
    const stored = JSON.parse(await readFile(target, "utf8"));
    expect(Object.keys(stored.benchmarks).sort()).toEqual([
      JSON.stringify(["a", "sample.bench.js", "sample"]),
      JSON.stringify(["b", "sample.bench.js", "sample"]),
    ]);
    // Both projects must compare with the same root-relative baseline.
    const passing = await runBenchmarkTests({ config, benchmarkCompare: "baselines/merged.json", benchmarkThreshold: 100 });
    expect(passing.files.map((file) => file.results[0]!.state)).toEqual(["pass", "pass"]);
    for (const stats of Object.values(stored.benchmarks) as { hz: number }[]) stats.hz = Number.MAX_VALUE;
    const historical = JSON.stringify(stored);
    await writeFile(target, historical);
    const compared = await runBenchmarkTests({ ...options, benchmarkCompare: "baselines/merged.json" });
    expect(compared.files.map((file) => file.results[0]!.state)).toEqual(["fail", "fail"]);
    expect(await readFile(target, "utf8")).toBe(historical);
    await writeFile(path.join(temp, "b", "sample.bench.js"),
      'bench("sample", () => { throw new Error("failed"); }, { time: 2, iterations: 3, warmup: false });\n');
    const failed = await runBenchmarkTests(options);
    expect(failed.files[1]!.results[0]!.state).toBe("fail");
    expect(await readFile(target, "utf8")).toBe(historical);
    await writeFile(path.join(temp, "b", "sample.bench.js"), 'throw new Error("collection failed");\n');
    const collectionFailed = await runBenchmarkTests(options);
    expect(collectionFailed.files[1]!.error!.message).toContain("collection failed");
    expect(await readFile(target, "utf8")).toBe(historical);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 30000);
