import path from "node:path";
import type { createServer } from "@nasti-toolchain/nasti";
import type { DurationBreakdown, FileResult, ResolvedLightningConfig, TestError, TestResult } from "../types.ts";
import { finishCollection, startCollection } from "./collect.ts";
import { runSuiteTree } from "./run.ts";
import { installGlobals } from "./globals.ts";
import { cleanupViState } from "../mock/index.ts";
import {
  finishSnapshotFile,
  setCurrentSnapshotTest,
  startSnapshotFile,
} from "../snapshot/index.ts";
import { CoverageSession } from "../coverage/index.ts";
import { resolveFileEnvironment, setupEnvironment } from "../environments/index.ts";
import type { V8CoverageScript } from "../types.ts";
import { captureUnhandledErrors, unhandledErrorResults } from "./unhandled.ts";
import { enrichCoverage } from "../node/test-server.ts";
import { startIstanbulCoverage, finishIstanbulCoverage } from "../coverage/istanbul-core.ts";
import { getTransformDuration, prepareTransformTiming } from "../utils/transform-timing.ts";

type DevServer = Awaited<ReturnType<typeof createServer>>;

function fileToUrl(root: string, file: string): string {
  return "/" + path.relative(root, file).split(path.sep).join("/");
}

function toError(value: unknown): TestError {
  if (value instanceof Error) return { message: value.message, stack: value.stack ?? "" };
  return { message: String(value) };
}

export interface RunTestFileOptions {
  config: ResolvedLightningConfig;
  file: string;
  server: DevServer;
  hasGlobalOnly: boolean;
}

export async function runTestFile(options: RunTestFileOptions): Promise<FileResult> {
  const { config, file, server, hasGlobalOnly } = options;
  const start = performance.now();
  const durationBreakdown: DurationBreakdown = {
    transformMs: 0,
    setupMs: 0,
    importMs: 0,
    testsMs: 0,
    environmentMs: 0,
  };
  const environment = await resolveFileEnvironment(config, file);
  let env: Awaited<ReturnType<typeof setupEnvironment>> | undefined;
  let coverage: CoverageSession | undefined;
  let restoreGlobals: (() => void) | undefined;
  const unhandled = captureUnhandledErrors();
  let result: FileResult;

  async function stopCoverage(): Promise<V8CoverageScript[] | undefined> {
    if (!coverage) return undefined;
    const current = coverage;
    coverage = undefined;
    return enrichCoverage(server, await current.stop());
  }

  try {
    const environmentStart = performance.now();
    try {
      env = await setupEnvironment(environment);
    } finally {
      durationBreakdown.environmentMs += performance.now() - environmentStart;
    }
    const setupStart = performance.now();
    try {
      if (config.coverage.enabled && config.coverage.provider === "istanbul") startIstanbulCoverage();
      if (config.coverage.enabled && config.coverage.provider === "v8") {
        coverage = new CoverageSession(config.root);
        await coverage.start();
      }
      if (config.globals) restoreGlobals = installGlobals();

      startCollection();
      startSnapshotFile({
        testFile: file,
        snapshotDir: config.snapshotDir,
        update: config.updateSnapshots,
      });

      await prepareTransformTiming(server, "ssr");
    } finally {
      durationBreakdown.setupMs += performance.now() - setupStart;
    }
    const transformStart = getTransformDuration(server, "ssr");
    const importStart = performance.now();
    try {
      await server.ssrLoadModule(fileToUrl(config.root, file));
    } finally {
      durationBreakdown.importMs += performance.now() - importStart;
      durationBreakdown.transformMs += getTransformDuration(server, "ssr") - transformStart;
    }
    const { root, hasOnly } = finishCollection();
    let results: TestResult[];
    const testsStart = performance.now();
    const testsTransformStart = getTransformDuration(server, "ssr");
    try {
      results = await runSuiteTree(root, {
        hasOnly: hasOnly || hasGlobalOnly,
        defaultTimeout: config.testTimeout,
        retry: config.retry,
        repeats: config.repeats,
        ...(config.testNamePattern ? { namePattern: config.testNamePattern } : {}),
        onTestStart: (name) => setCurrentSnapshotTest(name),
        onTestEnd: () => setCurrentSnapshotTest(undefined),
      });
      await unhandled.drain();
    } finally {
      durationBreakdown.testsMs += performance.now() - testsStart;
      durationBreakdown.transformMs += getTransformDuration(server, "ssr") - testsTransformStart;
    }
    results.push(...unhandledErrorResults(unhandled.errors));
    const coverageScripts = await stopCoverage();
    result = {
      filepath: file,
      results,
      durationMs: 0,
      durationBreakdown,
      environment,
      ...(unhandled.errors.length ? { unhandledErrors: unhandled.errors } : {}),
      ...(config.projectName ? { projectName: config.projectName } : {}),
      ...(coverageScripts ? { coverage: coverageScripts } : {}),
      ...(config.coverage.enabled && config.coverage.provider === "istanbul" ? { istanbulCoverage: finishIstanbulCoverage() } : {}),
    };
  } catch (err) {
    const coverageScripts = await stopCoverage().catch(() => undefined);
    result = {
      filepath: file,
      results: [],
      error: toError(err),
      durationMs: 0,
      durationBreakdown,
      environment,
      ...(config.projectName ? { projectName: config.projectName } : {}),
      ...(coverageScripts ? { coverage: coverageScripts } : {}),
      ...(config.coverage.enabled && config.coverage.provider === "istanbul" ? { istanbulCoverage: finishIstanbulCoverage() } : {}),
    };
  } finally {
    await stopCoverage().catch(() => undefined);
    unhandled.close();
    restoreGlobals?.();
    finishSnapshotFile();
    cleanupViState();
    const environmentStart = performance.now();
    try {
      await env?.teardown();
    } finally {
      durationBreakdown.environmentMs += performance.now() - environmentStart;
    }
  }
  result.durationMs = performance.now() - start;
  return result;
}
