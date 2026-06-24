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
export { vi, fn, spyOn, isMockFunction } from "./mock/index.ts";
export { defineConfig } from "./config/define.ts";

export type {
  LightningConfig,
  TestOptions,
  TestPool,
  PoolOptions,
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
