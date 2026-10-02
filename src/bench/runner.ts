import path from "node:path";
import { Bench } from "tinybench";
import type { FileResult, ResolvedLightningConfig, TestResult, Suite } from "../types.ts";
import { createOneShotServer } from "../node/one-shot-server.ts";
import { startBenchmarkCollection, finishBenchmarkCollection } from "./index.ts";
import type { BenchmarkTask } from "./index.ts";
import { startCollection, finishCollection } from "../runtime/collect.ts";
import { runSuiteTree } from "../runtime/run.ts";
import { getExecutionScope } from "../runtime/context.ts";
import { createBenchmarkContext } from "./context.ts";
import { installGlobals } from "../runtime/globals.ts";
import { captureUnhandledErrors, unhandledErrorResults } from "../runtime/unhandled.ts";

export const BENCH_INCLUDE = ["**/*.{bench,benchmark}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"];
export interface BenchmarkStats {
  hz: number;
  latency: { mean: number; min: number; max: number; p50: number; p99: number; rme: number; sd: number };
  samples: number;
}
export interface BenchmarkResult extends TestResult {
  benchmark?: BenchmarkStats;
}
export interface BenchmarkRunOptions {
  hasGlobalOnly?: boolean;
  baseline?: BenchmarkBaseline;
  /** Maximum permitted throughput loss, in percent. Default 10. */
  threshold?: number;
}
export interface BenchmarkBaseline {
  version: 1;
  benchmarks: Record<string, BenchmarkStats>;
}
export async function measureBenchmark(task: BenchmarkTask): Promise<BenchmarkStats> {
  const runner = new Bench({ ...task.options, throws: true });
  runner.add(task.name, task.fn);
  await runner.run();
  const result = runner.tasks[0]?.result;
  if (!result || result.state !== "completed") throw new Error(`Benchmark ${task.name} did not complete`);
  const { latency, throughput } = result;
  return {
    hz: throughput.mean,
    latency: { mean: latency.mean, min: latency.min, max: latency.max, p50: latency.p50, p99: latency.p99, rme: latency.rme, sd: latency.sd },
    samples: runner.tasks[0]!.runs,
  };
}
export function benchmarkRegression(current: number, previous: number, threshold: number): string | undefined {
  if (!Number.isFinite(previous) || previous <= 0) return "Baseline throughput must be finite and greater than zero";
  if (!Number.isFinite(current) || current <= 0) return "Measured throughput must be finite and greater than zero";
  const loss = (previous - current) / previous * 100;
  return loss > threshold
    ? `Benchmark regression: throughput decreased ${loss.toFixed(2)}% (maximum ${threshold}%)`
    : undefined;
}
export function formatBenchmarkReport(files: FileResult[]): string {
  const lines = ["Benchmark | hz | mean latency (ms) | samples | RME"];
  for (const file of files) for (const result of file.results as BenchmarkResult[]) {
    const stats = result.benchmark;
    if (stats) lines.push(`${result.fullName} | ${stats.hz.toFixed(2)} | ${stats.latency.mean.toFixed(6)} | ${stats.samples} | ${stats.latency.rme.toFixed(2)}%`);
  }
  return lines.join("\n");
}
/** Collect all entries before measuring so .only applies across files. */
export async function runBenchmarks(files: string[], config: ResolvedLightningConfig, options: BenchmarkRunOptions = {}): Promise<{ files: FileResult[]; benchmarks: BenchmarkBaseline["benchmarks"] }> {
  const threshold = options.threshold ?? 10;
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error("Benchmark threshold must be a non-negative finite percentage");
  const baseline = options.baseline;
  const entries: { file: FileResult; tasks: BenchmarkTask[]; root?: Suite; hasOnly?: boolean; server?: Awaited<ReturnType<typeof createOneShotServer>> }[] = [];
  const output: BenchmarkBaseline = { version: 1, benchmarks: {} };
  try {
    for (const filepath of files) {
      const file: FileResult = { filepath, results: [], durationMs: 0, ...(config.projectName ? { projectName: config.projectName } : {}) };
      const entry: typeof entries[number] = { file, tasks: [] };
      entries.push(entry);
      const start = performance.now();
      const restore = config.globals ? installGlobals() : undefined;
      try {
        entry.server = await createOneShotServer(config.nasti);
        startBenchmarkCollection();
        startCollection();
        await entry.server.ssrLoadModule("/" + path.relative(config.root, filepath).split(path.sep).join("/"));
        const collection = finishCollection();
        entry.root = collection.root;
        entry.hasOnly = collection.hasOnly;
        entry.tasks = finishBenchmarkCollection();
        const names = new Set<string>();
        for (const task of entry.tasks) {
          if (names.has(task.name)) throw new Error(`Duplicate benchmark name: ${task.name}`);
          names.add(task.name);
        }
      } catch (error) {
        finishBenchmarkCollection();
        file.error = { message: error instanceof Error ? error.message : String(error) };
      } finally {
        restore?.();
      }
      file.durationMs = performance.now() - start;
    }
    const hasOnly = options.hasGlobalOnly || entries.some((entry) => entry.hasOnly || entry.tasks.some((task) => task.mode === "only"));
    for (const entry of entries) {
      if (entry.file.error) continue;
      const restore = config.globals ? installGlobals() : undefined;
      const unhandled = captureUnhandledErrors();
      const contextResults: BenchmarkResult[] = [];
      try {
        if (entry.root) {
          const results = await runSuiteTree(entry.root, {
            hasOnly, defaultTimeout: config.testTimeout, retry: config.retry, repeats: config.repeats,
            ...(config.testNamePattern ? { namePattern: config.testNamePattern } : {}),
            createBenchmarkContext: () => createBenchmarkContext((name, value) => {
              const stats: BenchmarkStats = {
                hz: value.throughput.mean,
                latency: { mean: value.latency.mean, min: value.latency.min, max: value.latency.max, p50: value.latency.p50, p99: value.latency.p99, rme: value.latency.rme, sd: value.latency.sd },
                samples: value.latency.samples?.length ?? 0,
              };
              contextResults.push({ fullName: `${getExecutionScope()?.snapshotName ?? "benchmark"} > ${name}`, state: "pass", durationMs: 0, benchmark: stats });
            }),
          });
          entry.file.results.push(...results, ...contextResults);
          for (const result of contextResults) {
            const id = JSON.stringify([config.projectName ?? "", path.relative(config.root, entry.file.filepath).split(path.sep).join("/"), result.fullName]);
            output.benchmarks[id] = result.benchmark!;
            const previous = baseline?.benchmarks[id];
            const regression = baseline && !previous ? `Benchmark missing from baseline: ${result.fullName}`
              : previous ? benchmarkRegression(result.benchmark!.hz, previous.hz, threshold) : undefined;
            if (regression) { result.state = "fail"; result.error = { message: regression }; }
          }
        }
        await unhandled.drain();
        entry.file.results.push(...unhandledErrorResults(unhandled.errors));
      } finally {
        restore?.();
        unhandled.close();
      }
      for (const task of entry.tasks) {
        const start = performance.now();
        const result: BenchmarkResult = { fullName: task.name, state: "skip", durationMs: 0 };
        entry.file.results.push(result);
        const pattern = config.testNamePattern;
        if (pattern) pattern.lastIndex = 0;
        if (task.mode === "skip" || (hasOnly && task.mode !== "only") || (pattern && !pattern.test(task.name))) continue;
        try {
          result.benchmark = await measureBenchmark(task);
          const id = JSON.stringify([config.projectName ?? "", path.relative(config.root, entry.file.filepath).split(path.sep).join("/"), task.name]);
          output.benchmarks[id] = result.benchmark;
          const previous = baseline?.benchmarks[id];
          const regression = baseline && !previous
            ? `Benchmark missing from baseline: ${task.name}`
            : previous ? benchmarkRegression(result.benchmark.hz, previous.hz, threshold) : undefined;
          result.state = regression ? "fail" : "pass";
          if (regression) result.error = { message: regression };
        } catch (error) {
          result.state = "fail";
          result.error = { message: error instanceof Error ? error.message : String(error) };
        }
        result.durationMs = performance.now() - start;
        entry.file.durationMs += result.durationMs;
      }
    }
    return { files: entries.map((entry) => entry.file), benchmarks: output.benchmarks };
  } finally {
    finishBenchmarkCollection();
    for (const entry of entries) await entry.server?.close();
  }
}
