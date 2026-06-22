/**
 * The live test API surface, plus an installer that mirrors it onto `globalThis`
 * for `globals: true` (Vitest parity). The primary path is importing from
 * `@lightning-js/lightning`; ssr-loaded specs share this module instance with the
 * host, so imported `test`/`expect` bind to the same collector singleton.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
  test,
} from "./collect.ts";
import { expect } from "../expect/index.ts";
import { vi } from "../mock/index.ts";

export const api = {
  test,
  it,
  describe,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} as const;

let installed = false;

/** Assign the API onto `globalThis` (idempotent). */
export function installGlobals(): void {
  if (installed) return;
  installed = true;
  for (const [key, value] of Object.entries(api)) {
    (globalThis as Record<string, unknown>)[key] = value;
  }
}
