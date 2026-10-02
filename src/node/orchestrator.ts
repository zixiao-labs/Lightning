/**
 * Orchestrator: resolve config → discover specs → run files through the selected
 * pool → aggregate reporter output → return summary/exit information.
 */
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { glob } from "tinyglobby";
import type { FileResult, ResolvedLightningConfig, RunSummary } from "../types.ts";
import {
  resolveLightningConfigs,
  resolveRootLightningConfig,
  type ConfigOverrides,
} from "../config/resolve.ts";
import { reportCoverage } from "./test-server.ts";
import { createIstanbulCoverageReport } from "../coverage/istanbul.ts";
import { createReporterManager, type ReporterManager } from "../reporters/index.ts";
import { createRunSummary } from "../reporters/summary.ts";
import { runFilesInBrowser } from "../browser/pool.ts";
import { runFilesInPool } from "./pool.ts";
import { applyShard } from "./sharding.ts";
import { detectGlobalOnly } from "./only.ts";
import { runTypechecks, TYPECHECK_INCLUDE, isTypeTestFile } from "../typecheck/index.ts";
import { runBenchmarks, BENCH_INCLUDE, formatBenchmarkReport, type BenchmarkBaseline } from "../bench/runner.ts";

async function discover(
  config: ResolvedLightningConfig,
  fileFilters: string[],
  include = config.include,
  exclude = config.exclude,
): Promise<string[]> {
  const matches = await glob(include, {
    cwd: config.root,
    ignore: exclude,
    absolute: true,
    dot: false,
    followSymbolicLinks: false,
  });
  const normalized = matches.map((m) => m.split(path.sep).join("/")).sort();
  if (fileFilters.length === 0) return normalized;
  const needles = fileFilters.map((n) => n.split(path.sep).join("/"));
  return normalized.filter((file) =>
    needles.some((needle) => file.includes(needle)),
  );
}

export interface RunResult {
  summary: RunSummary;
  files: FileResult[];
}

async function runSingleConfig(
  config: ResolvedLightningConfig,
  overrides: ConfigOverrides,
  files: string[],
  typeFiles: string[],
  hasGlobalOnly: boolean,
  reporter: ReporterManager,
): Promise<FileResult[]> {
  const onFileDone = (file: FileResult) => reporter.onFileDone(file);
  const fileResults = config.browser.enabled
    ? await runFilesInBrowser({ config, files, hasGlobalOnly, onFileDone })
    : await runFilesInPool({ config, overrides, files, hasGlobalOnly, onFileDone });
  const typeResults = await runTypechecks(typeFiles, config, config.typecheck);
  for (const file of typeResults) await onFileDone(file);
  fileResults.push(...typeResults);

  if (config.coverage.enabled) {
    const scripts = fileResults.flatMap((file) => file.coverage ?? []);
    const report = config.coverage.provider === "istanbul"
      ? await createIstanbulCoverageReport(config, fileResults.map((file) => file.istanbulCoverage ?? {}))
      : await reportCoverage(config, scripts);
    if (report.thresholdErrors.length > 0) {
      const failure: FileResult = { filepath: path.join(config.root, "coverage"), results: [], durationMs: 0, error: { message: report.thresholdErrors.join("\n") } };
      fileResults.push(failure);
      await reporter.onFileDone(failure);
    }
  }

  return fileResults;
}

export async function runTests(
  overrides: ConfigOverrides = {},
  fileFilters: string[] = [],
): Promise<RunResult> {
  const entries = await resolveLightningConfigs(overrides);
  const rootConfig = await resolveRootLightningConfig(overrides);
  const reporter = await createReporterManager(rootConfig);
  const plans = await Promise.all(entries.map(async (entry) => ({
    ...entry,
    files: applyShard((await discover(entry.config, fileFilters)).filter((file) => !isTypeTestFile(file)), entry.config.shard),
    typeFiles: entry.config.typecheck.enabled ? applyShard(await discover(entry.config, fileFilters, TYPECHECK_INCLUDE), entry.config.shard) : [],
  })));
  const hasGlobalOnly = await detectGlobalOnly(plans.flatMap((plan) => plan.files));
  await reporter.onStart(plans.reduce((count, plan) => count + plan.files.length * (plan.config.browser.enabled ? plan.config.browser.browsers.length : 1) + plan.typeFiles.length, 0), rootConfig.root);
  const start = performance.now();
  const files: FileResult[] = [];
  for (const plan of plans) {
    files.push(...await runSingleConfig(plan.config, plan.overrides, plan.files, plan.typeFiles, hasGlobalOnly, reporter));
  }
  const summary = createRunSummary(files, performance.now() - start);
  await reporter.onFinished(files, summary);
  return { summary, files };
}

export async function runBenchmarkTests(
  overrides: ConfigOverrides = {},
  fileFilters: string[] = [],
): Promise<RunResult> {
  const entries = await resolveLightningConfigs(overrides);
  const rootConfig = await resolveRootLightningConfig(overrides);
  const reporter = await createReporterManager(rootConfig);
  const plans = await Promise.all(entries.map(async ({ config }) => ({
    config, files: applyShard(await discover(config, fileFilters, BENCH_INCLUDE), config.shard),
  })));
  await reporter.onStart(plans.reduce((count, plan) => count + plan.files.length, 0), rootConfig.root);
  const start = performance.now();
  const results: FileResult[] = [];
  let baseline: BenchmarkBaseline | undefined;
  if (rootConfig.benchmark.compare) {
    baseline = JSON.parse(await readFile(path.resolve(rootConfig.root, rootConfig.benchmark.compare), "utf8")) as BenchmarkBaseline;
    if (baseline.version !== 1 || !baseline.benchmarks || typeof baseline.benchmarks !== "object") throw new Error("Invalid benchmark baseline");
  }
  const output: BenchmarkBaseline = { version: 1, benchmarks: {} };
  const hasGlobalOnly = await detectGlobalOnly(plans.flatMap((plan) => plan.files), "bench");
  for (const { config, files } of plans) {
    if (config.browser.enabled) throw new Error("Benchmarks currently require the Node runner; disable browser mode.");
    const { files: fileResults, benchmarks } = await runBenchmarks(files, config, {
      hasGlobalOnly,
      ...(baseline ? { baseline } : {}),
      ...(config.benchmark.threshold !== undefined ? { threshold: config.benchmark.threshold } : {}),
    });
    Object.assign(output.benchmarks, benchmarks);
    for (const file of fileResults) await reporter.onFileDone(file);
    results.push(...fileResults);
  }
  if (rootConfig.benchmark.baseline && !results.some((file) => file.error || file.results.some((result) => result.state === "fail"))) {
    const target = path.resolve(rootConfig.root, rootConfig.benchmark.baseline);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(output, null, 2) + "\n");
  }
  if (rootConfig.reporters.includes("default") || rootConfig.reporters.includes("verbose")) console.log(formatBenchmarkReport(results));
  const summary = createRunSummary(results, performance.now() - start);
  await reporter.onFinished(results, summary);
  return { files: results, summary };
}
