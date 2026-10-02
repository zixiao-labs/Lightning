import path from "node:path";
import type { createServer } from "@nasti-toolchain/nasti";
import type { FileResult, ResolvedLightningConfig, TestError } from "../types.ts";
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
  const environment = await resolveFileEnvironment(config, file);
  let env: Awaited<ReturnType<typeof setupEnvironment>> | undefined;
  let coverage: CoverageSession | undefined;
  let restoreGlobals: (() => void) | undefined;
  const unhandled = captureUnhandledErrors();

  async function stopCoverage(): Promise<V8CoverageScript[] | undefined> {
    if (!coverage) return undefined;
    const current = coverage;
    coverage = undefined;
    return enrichCoverage(server, await current.stop());
  }

  try {
    env = await setupEnvironment(environment);
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

    await server.ssrLoadModule(fileToUrl(config.root, file));
    const { root, hasOnly } = finishCollection();
    const results = await runSuiteTree(root, {
      hasOnly: hasOnly || hasGlobalOnly,
      defaultTimeout: config.testTimeout,
      retry: config.retry,
      repeats: config.repeats,
      ...(config.testNamePattern ? { namePattern: config.testNamePattern } : {}),
      onTestStart: (name) => setCurrentSnapshotTest(name),
      onTestEnd: () => setCurrentSnapshotTest(undefined),
    });
    await unhandled.drain();
    results.push(...unhandledErrorResults(unhandled.errors));
    const coverageScripts = await stopCoverage();
    return {
      filepath: file,
      results,
      durationMs: performance.now() - start,
      environment,
      ...(unhandled.errors.length ? { unhandledErrors: unhandled.errors } : {}),
      ...(config.projectName ? { projectName: config.projectName } : {}),
      ...(coverageScripts ? { coverage: coverageScripts } : {}),
      ...(config.coverage.enabled && config.coverage.provider === "istanbul" ? { istanbulCoverage: finishIstanbulCoverage() } : {}),
    };
  } catch (err) {
    const coverageScripts = await stopCoverage().catch(() => undefined);
    return {
      filepath: file,
      results: [],
      error: toError(err),
      durationMs: performance.now() - start,
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
    await env?.teardown();
  }
}
