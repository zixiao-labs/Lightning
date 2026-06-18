/**
 * Orchestrator: the Phase 0 run pipeline.
 *
 *   resolve config → discover specs → createServer → for each file
 *   { reset collector → ssrLoadModule → run tree } → report → exit code.
 *
 * Serial + in-process by design (ROADMAP Phase 0). The worker pool and file-level
 * isolation arrive in Phase 1; here we lean on Nasti's in-process module runner.
 */
import path from "node:path";
import { glob } from "tinyglobby";
import { createServer } from "@nasti-toolchain/nasti";
import type { FileResult, ResolvedLightningConfig, TestError } from "../types.ts";
import { finishCollection, startCollection } from "../runtime/collect.ts";
import { runSuiteTree } from "../runtime/run.ts";
import { installGlobals } from "../runtime/globals.ts";
import { resolveLightningConfig, type ConfigOverrides } from "../config/resolve.ts";
import { createDefaultReporter, type Reporter, type RunSummary } from "../reporters/default.ts";

function fileToUrl(root: string, file: string): string {
  return "/" + path.relative(root, file).split(path.sep).join("/");
}

function toError(value: unknown): TestError {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack ?? "" };
  }
  return { message: String(value) };
}

async function discover(config: ResolvedLightningConfig, fileFilters: string[]): Promise<string[]> {
  const matches = await glob(config.include, {
    cwd: config.root,
    ignore: config.exclude,
    absolute: true,
    dot: false,
  });
  const normalized = matches.map((m) => m.split(path.sep).join("/")).sort();
  if (fileFilters.length === 0) return normalized;
  return normalized.filter((f) => fileFilters.some((needle) => f.includes(needle)));
}

export interface RunResult {
  summary: RunSummary;
  files: FileResult[];
}

export async function runTests(
  overrides: ConfigOverrides = {},
  fileFilters: string[] = [],
): Promise<RunResult> {
  const config = await resolveLightningConfig(overrides);
  const reporter: Reporter = createDefaultReporter({ root: config.root });

  if (config.globals) installGlobals();

  const files = await discover(config, fileFilters);
  reporter.onStart(files.length, config.root);

  const fileResults: FileResult[] = [];
  const server = await createServer(config.nasti);

  try {
    for (const file of files) {
      const start = performance.now();
      startCollection();
      let fileResult: FileResult;
      try {
        await server.ssrLoadModule(fileToUrl(config.root, file));
        const { root, hasOnly } = finishCollection();
        const runOpts = {
          hasOnly,
          defaultTimeout: config.testTimeout,
          ...(config.testNamePattern ? { namePattern: config.testNamePattern } : {}),
        };
        const results = await runSuiteTree(root, runOpts);
        fileResult = { filepath: file, results, durationMs: performance.now() - start };
      } catch (err) {
        // Import/collection-time failure: the whole file is a failure, not a crash.
        fileResult = {
          filepath: file,
          results: [],
          error: toError(err),
          durationMs: performance.now() - start,
        };
      }
      fileResults.push(fileResult);
      reporter.onFileDone(fileResult);
    }
  } finally {
    await server.close();
  }

  const summary = reporter.onFinished(fileResults);
  return { summary, files: fileResults };
}
