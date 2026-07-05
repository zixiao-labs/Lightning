import { readFile } from "node:fs/promises";
import type { ResolvedLightningConfig, TestEnvironment } from "../types.ts";

export interface EnvironmentInstance {
  name: TestEnvironment;
  teardown(): void | Promise<void>;
}

const DOCBLOCK_RE = /@lightning-environment\s+([^\s*]+)/;

class InvalidEnvironmentError extends Error {
  readonly code = "ERR_LIGHTNING_INVALID_ENVIRONMENT";
}

function isInvalidEnvironmentError(error: unknown): error is InvalidEnvironmentError {
  return error instanceof InvalidEnvironmentError || (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ERR_LIGHTNING_INVALID_ENVIRONMENT"
  );
}

function defineGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function createGlobalPatcher() {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const patched = new Set<string>();

  return {
    set(key: string, value: unknown) {
      if (!patched.has(key)) {
        previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        patched.add(key);
      }
      defineGlobal(key, value);
    },
    restore() {
      for (const key of [...patched].reverse()) {
        const descriptor = previous.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

async function importOptional<T>(specifier: string, installHint: string): Promise<T> {
  try {
    const importer = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<T>;
    return await importer(specifier);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${installHint}\nOriginal error: ${message}`);
  }
}

function copyDomGlobals(window: Record<string, unknown>, patcher: ReturnType<typeof createGlobalPatcher>): void {
  const keys = [
    "window",
    "self",
    "document",
    "navigator",
    "location",
    "history",
    "HTMLElement",
    "SVGElement",
    "Element",
    "Node",
    "Text",
    "Comment",
    "DocumentFragment",
    "Event",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
    "MutationObserver",
    "getComputedStyle",
    "DOMParser",
    "File",
    "Blob",
    "FormData",
    "URL",
    "URLSearchParams",
    "localStorage",
    "sessionStorage",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ];

  patcher.set("window", window);
  patcher.set("self", window);
  patcher.set("global", globalThis);
  for (const key of keys) {
    const value = window[key];
    if (value !== undefined) patcher.set(key, value);
  }
}

async function setupJsdom(): Promise<EnvironmentInstance> {
  const mod = await importOptional<{
    JSDOM: new (html?: string, options?: Record<string, unknown>) => {
      window: Record<string, unknown> & { close?: () => void };
    };
  }>("jsdom", "Lightning environment 'jsdom' requires installing optional dependency: pnpm add -D jsdom");

  const patcher = createGlobalPatcher();
  const dom = new mod.JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  copyDomGlobals(dom.window, patcher);
  return {
    name: "jsdom",
    teardown() {
      dom.window.close?.();
      patcher.restore();
    },
  };
}

async function setupHappyDom(): Promise<EnvironmentInstance> {
  const mod = await importOptional<{
    Window: new (options?: Record<string, unknown>) => Record<string, unknown> & { close?: () => void };
  }>("happy-dom", "Lightning environment 'happy-dom' requires installing optional dependency: pnpm add -D happy-dom");

  const patcher = createGlobalPatcher();
  const window = new mod.Window({ url: "http://localhost/" });
  copyDomGlobals(window, patcher);
  return {
    name: "happy-dom",
    teardown() {
      window.close?.();
      patcher.restore();
    },
  };
}

function setupNode(): EnvironmentInstance {
  return { name: "node", teardown() {} };
}

function setupEdgeRuntime(): EnvironmentInstance {
  // Lightweight edge compatibility, not a sandbox: Node-specific globals such as
  // process, Buffer, require, module, and __dirname are not hidden. This only
  // ensures common Web-standard APIs are present on globalThis/self.
  const patcher = createGlobalPatcher();
  patcher.set("self", globalThis);
  const webKeys = [
    "fetch",
    "Request",
    "Response",
    "Headers",
    "FormData",
    "Blob",
    "File",
    "ReadableStream",
    "WritableStream",
    "TransformStream",
    "TextEncoder",
    "TextDecoder",
    "URL",
    "URLSearchParams",
    "crypto",
    "structuredClone",
    "atob",
    "btoa",
    "queueMicrotask",
  ];
  for (const key of webKeys) {
    const value = (globalThis as Record<string, unknown>)[key];
    if (value !== undefined) patcher.set(key, value);
  }
  return {
    name: "edge-runtime",
    teardown() {
      patcher.restore();
    },
  };
}

export async function resolveFileEnvironment(
  config: ResolvedLightningConfig,
  file: string,
): Promise<TestEnvironment> {
  try {
    const source = await readFile(file, "utf-8");
    const header = source.slice(0, 2048);
    const match = DOCBLOCK_RE.exec(header);
    if (match?.[1]) {
      const value = match[1] as TestEnvironment;
      if (["node", "jsdom", "happy-dom", "edge-runtime"].includes(value)) return value;
      throw new InvalidEnvironmentError(`Invalid @lightning-environment '${match[1]}' in ${file}`);
    }
  } catch (error) {
    if (isInvalidEnvironmentError(error)) throw error;
    // Ignore read errors here; importing the file will surface them as the real failure.
  }
  return config.environment;
}

export async function setupEnvironment(environment: TestEnvironment): Promise<EnvironmentInstance> {
  if (environment === "node") return setupNode();
  if (environment === "jsdom") return setupJsdom();
  if (environment === "happy-dom") return setupHappyDom();
  return setupEdgeRuntime();
}
