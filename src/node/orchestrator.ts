/**
 * Orchestrator: resolve config → discover specs → run files through the selected
 * pool → aggregate reporter output → return summary/exit information.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { glob } from "tinyglobby";
import type { FileResult, ResolvedLightningConfig } from "../types.ts";
import {
  resolveLightningConfig,
  type ConfigOverrides,
} from "../config/resolve.ts";
import {
  createDefaultReporter,
  type Reporter,
  type RunSummary,
} from "../reporters/default.ts";
import { runFilesInPool } from "./pool.ts";

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

/** Build the reporter from the resolved config. Phase 2 still ships only `default`. */
function createReporter(config: ResolvedLightningConfig): Reporter {
  const ids = config.reporters.length > 0 ? config.reporters : ["default"];
  const unknown = ids.filter((id) => id !== "default");
  if (unknown.length > 0) {
    throw new Error(
      `Unknown reporter(s): ${unknown.join(", ")}. Lightning currently ships only "default".`,
    );
  }
  return createDefaultReporter({ root: config.root });
}

export async function runTests(
  overrides: ConfigOverrides = {},
  fileFilters: string[] = [],
): Promise<RunResult> {
  const config = await resolveLightningConfig(overrides);
  const reporter = createReporter(config);
  const files = await discover(config, fileFilters);
  const hasGlobalOnly = await detectGlobalOnly(files);

  reporter.onStart(files.length, config.root);

  const fileResults = await runFilesInPool({
    config,
    overrides,
    files,
    hasGlobalOnly,
    onFileDone: (file) => reporter.onFileDone(file),
  });

  const summary = reporter.onFinished(fileResults);
  return { summary, files: fileResults };
}
