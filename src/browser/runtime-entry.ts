/**
 * Entry for the self-contained browser runtime bundle (`dist/browser-runtime.mjs`).
 *
 * In browser mode this module is served verbatim as the virtual module behind
 * `/@modules/@lightning-js/lightning` (see `./plugin.ts`), so a spec's
 * `import { test, expect } from "@lightning-js/lightning"` binds to the same
 * collector instance the in-page runner drives. It must therefore stay free of
 * Node imports and be bundled without chunk splitting (see tsdown config).
 */
export {
  test,
  it,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "../runtime/collect.ts";
export { expect, LightningAssertionError } from "../expect/index.ts";
export { vi, fn, spyOn, isMockFunction } from "../mock/index.ts";
export { render, cleanup, userEvent, type RenderResult } from "./public.ts";

import type { LightningConfig } from "../types.ts";
/** Inert in the browser; present so a stray config import can't break a spec. */
export function defineConfig(config: LightningConfig): LightningConfig {
  return config;
}

import { finishCollection, startCollection } from "../runtime/collect.ts";
import { runSuiteTree, type RunOptions } from "../runtime/run.ts";
import { installGlobals } from "../runtime/globals.ts";
import { cleanupViState } from "../mock/index.ts";
import {
  finishSnapshotSession,
  setCurrentSnapshotTest,
  startSnapshotSession,
} from "../snapshot/core.ts";
import { cleanup } from "./public.ts";

/**
 * Internal surface for the tester page's inline entry script (`./client.ts`).
 * Not public API — the shape is versioned only by "entry and runtime ship in
 * the same package build".
 */
export const __lightning_browser__ = {
  startCollection,
  finishCollection,
  runSuiteTree: (root: Parameters<typeof runSuiteTree>[0], opts: RunOptions) =>
    runSuiteTree(root, opts),
  installGlobals,
  startSnapshotSession,
  finishSnapshotSession,
  setCurrentSnapshotTest,
  /** Per-test cleanup: rendered containers + per-file vi teardown at file end. */
  cleanupContainers: cleanup,
  cleanupViState,
};
