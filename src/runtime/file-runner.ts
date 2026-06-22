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

  if (config.globals) installGlobals();

  startCollection();
  startSnapshotFile({
    testFile: file,
    snapshotDir: config.snapshotDir,
    update: config.updateSnapshots,
  });

  try {
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
    return { filepath: file, results, durationMs: performance.now() - start };
  } catch (err) {
    return {
      filepath: file,
      results: [],
      error: toError(err),
      durationMs: performance.now() - start,
    };
  } finally {
    finishSnapshotFile();
    cleanupViState();
  }
}
