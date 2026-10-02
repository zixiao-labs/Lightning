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
import { onTestFinished, onTestFailed } from "./context.ts";
import { bench } from "../bench/index.ts";

export const api = {
  test,
  it,
  bench,
  describe,
  expect,
  vi,
  jest: vi,
  onTestFinished,
  onTestFailed,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} as const;

/** Install for one file; restore the exact previous descriptors at teardown. */
export function installGlobals(): () => void {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(api)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
