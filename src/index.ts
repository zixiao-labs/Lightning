/**
 * `@lightning-js/lightning` public API.
 *
 * Specs import their test/assertion functions from here:
 *
 *   import { test, expect } from "@lightning-js/lightning";
 *
 * Because Nasti's module runner externalizes bare imports to Node, an ssr-loaded
 * spec receives this exact module instance — so `test`/`describe` bind to the same
 * collector the orchestrator drives. With `globals: true`, these are also installed
 * on `globalThis`.
 */
export {
  test,
  it,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "./runtime/collect.ts";
export { expect, LightningAssertionError } from "./expect/index.ts";
export { onTestFinished, onTestFailed } from "./runtime/context.ts";
export type { TestContext } from "./runtime/context.ts";
export { vi, vi as jest, fn, spyOn, isMockFunction } from "./mock/index.ts";
export { defineConfig, defineProject } from "./config/define.ts";
export { mapJestConfig } from "./config/compat.ts";
export { bench, describeBench } from "./bench/index.ts";
export { expectTypeOf, assertType } from "./type-testing.ts";

/** Lazy Node orchestrator: importing test APIs does not load TypeScript. */
export async function lightning(
  options: import("./config/resolve.ts").ConfigOverrides = {},
  filters: string[] = [],
) {
  const { runTests } = await import("./node/orchestrator.ts");
  return runTests(options, filters);
}

export type {
  LightningConfig,
  TestOptions,
  TestPool,
  TestEnvironment,
  BuiltinReporter,
  Reporter,
  ReporterConfig,
  PoolOptions,
  CoverageOptions,
  CoverageProvider,
  CoverageReporter,
  CoverageThresholds,
  ShardOptions,
  ProjectConfig,
  RunSummary,
  Task,
  Suite,
  Test,
  TestResult,
  FileResult,
} from "./types.ts";
export type {
  Matchers,
  ExpectStatic,
  AsymmetricMatcherInterface,
} from "./expect/index.ts";
export type { MockInstance, MockContext, MockResult } from "./mock/index.ts";
