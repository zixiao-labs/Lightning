/**
 * Orchestrator: resolve config → discover specs → run files through the selected
 * pool → aggregate reporter output → return summary/exit information.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { glob } from "tinyglobby";
import type { FileResult, ResolvedLightningConfig, RunSummary } from "../types.ts";
import {
  resolveLightningConfigs,
  type ConfigOverrides,
} from "../config/resolve.ts";
import { createCoverageReport } from "../coverage/index.ts";
import { createReporterManager } from "../reporters/index.ts";
import { createRunSummary } from "../reporters/summary.ts";
import { runFilesInPool } from "./pool.ts";
import { applyShard } from "./sharding.ts";

async function discover(
  config: ResolvedLightningConfig,
  fileFilters: string[],
): Promise<string[]> {
  const matches = await glob(config.include, {
    cwd: config.root,
    ignore: config.exclude,
    absolute: true,
    dot: false,
  });
  const normalized = matches.map((m) => m.split(path.sep).join("/")).sort();
  if (fileFilters.length === 0) return normalized;
  const needles = fileFilters.map((n) => n.split(path.sep).join("/"));
  return normalized.filter((file) =>
    needles.some((needle) => file.includes(needle)),
  );
}

async function detectGlobalOnly(files: string[]): Promise<boolean> {
  const pattern = /\b(?:test|it|describe)\s*\.\s*only\s*\(/;
  for (const file of files) {
    try {
      if (pattern.test(await readFile(file, "utf-8"))) return true;
    } catch {
      // Loading the file later will surface the real error; only detection is best-effort.
    }
  }
  return false;
}

export interface RunResult {
  summary: RunSummary;
  files: FileResult[];
}

function mergeSummaries(summaries: RunSummary[]): RunSummary {
  return summaries.reduce<RunSummary>(
    (acc, summary) => ({
      totalFiles: acc.totalFiles + summary.totalFiles,
      failedFiles: acc.failedFiles + summary.failedFiles,
      passedTests: acc.passedTests + summary.passedTests,
      failedTests: acc.failedTests + summary.failedTests,
      skippedTests: acc.skippedTests + summary.skippedTests,
      todoTests: acc.todoTests + summary.todoTests,
      durationMs: acc.durationMs + summary.durationMs,
    }),
    {
      totalFiles: 0,
      failedFiles: 0,
      passedTests: 0,
      failedTests: 0,
      skippedTests: 0,
      todoTests: 0,
      durationMs: 0,
    },
  );
}

async function runSingleConfig(
  config: ResolvedLightningConfig,
  overrides: ConfigOverrides,
  fileFilters: string[],
): Promise<RunResult> {
  const reporter = await createReporterManager(config);
  const discovered = await discover(config, fileFilters);
  const files = applyShard(discovered, config.shard);
  const hasGlobalOnly = await detectGlobalOnly(files);
  const start = performance.now();

  await reporter.onStart(files.length, config.root);

  const fileResults = await runFilesInPool({
    config,
    overrides,
    files,
    hasGlobalOnly,
    onFileDone: (file) => reporter.onFileDone(file),
  });

  let summary = createRunSummary(fileResults, performance.now() - start);

  if (config.coverage.enabled) {
    const scripts = fileResults.flatMap((file) => file.coverage ?? []);
    const report = await createCoverageReport(config, scripts);
    if (report.thresholdErrors.length > 0) {
      summary = { ...summary, failedFiles: Math.max(summary.failedFiles, 1) };
    }
  }

  await reporter.onFinished(fileResults, summary);
  return { summary, files: fileResults };
}

export async function runTests(
  overrides: ConfigOverrides = {},
  fileFilters: string[] = [],
): Promise<RunResult> {
  const entries = await resolveLightningConfigs(overrides);
  const results: RunResult[] = [];
  for (const entry of entries) {
    results.push(await runSingleConfig(entry.config, entry.overrides, fileFilters));
  }
  return {
    summary: mergeSummaries(results.map((result) => result.summary)),
    files: results.flatMap((result) => result.files),
  };
}
