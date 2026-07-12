import type { NastiPlugin } from "@nasti-toolchain/nasti";

type AnyFunction = (...args: any[]) => any;

export interface MockResult {
  type: "return" | "throw" | "incomplete";
  value: unknown;
}

export interface MockContext {
  calls: unknown[][];
  instances: unknown[];
  contexts: unknown[];
  invocationCallOrder: number[];
  results: MockResult[];
}

export interface MockInstance<T extends AnyFunction = AnyFunction> {
  (...args: Parameters<T>): ReturnType<T>;
  _isMockFunction: true;
  mock: MockContext;
  getMockImplementation(): AnyFunction | undefined;
  mockImplementation(fn: T): this;
  mockImplementationOnce(fn: T): this;
  withImplementation<R>(fn: T, callback: () => R): R;
  mockReturnThis(): this;
  mockReturnValue(value: ReturnType<T>): this;
  mockReturnValueOnce(value: ReturnType<T>): this;
  mockResolvedValue(value: Awaited<ReturnType<T>>): this;
  mockResolvedValueOnce(value: Awaited<ReturnType<T>>): this;
  mockRejectedValue(value: unknown): this;
  mockRejectedValueOnce(value: unknown): this;
  mockClear(): this;
  mockReset(): this;
  mockRestore(): void;
  mockName(name: string): this;
  getMockName(): string;
}

interface MockConfig {
  implementation: AnyFunction | undefined;
  once: AnyFunction[];
  original: AnyFunction | undefined;
  restore: (() => void) | undefined;
  name: string;
}

const REGISTERED_MOCKS = new Set<MockInstance>();
const MOCK_CONFIGS = new WeakMap<MockInstance, MockConfig>();
let invocationCounter = 1;

function createContext(): MockContext {
  return {
    calls: [],
    instances: [],
    contexts: [],
    invocationCallOrder: [],
    results: [],
  };
}

export function isMockFunction(value: unknown): value is MockInstance {
  return (
    typeof value === "function" &&
    (value as { _isMockFunction?: boolean })._isMockFunction === true
  );
}

export function fn<T extends AnyFunction = AnyFunction>(
  implementation?: T,
): MockInstance<T> {
  if (isMockFunction(implementation)) return implementation as MockInstance<T>;

  const context = createContext();
  const config: MockConfig = {
    implementation,
    original: implementation,
    once: [],
    restore: undefined,
    name: "vi.fn()",
  };

  const mock = function (this: unknown, ...args: unknown[]) {
    context.calls.push(args);
    context.contexts.push(this);
    context.invocationCallOrder.push(invocationCounter++);

    if (new.target) context.instances.push(this);

    const result: MockResult = { type: "incomplete", value: undefined };
    context.results.push(result);

    const impl = config.once.shift() ?? config.implementation;
    try {
      const value = impl ? impl.apply(this, args) : undefined;
      result.type = "return";
      result.value = value;
      return value;
    } catch (error) {
      result.type = "throw";
      result.value = error;
      throw error;
    }
  } as unknown as MockInstance<T>;

  Object.defineProperty(mock, "_isMockFunction", { value: true });
  Object.defineProperty(mock, "mock", { value: context, enumerable: true });

  mock.getMockImplementation = () => config.once[0] ?? config.implementation;
  mock.mockImplementation = (next: T) => {
    config.implementation = next;
    return mock;
  };
  mock.mockImplementationOnce = (next: T) => {
    config.once.push(next);
    return mock;
  };
  mock.withImplementation = (next, callback) => {
    const previous = config.implementation;
    const previousOnce = config.once;
    config.implementation = next;
    config.once = [];
    const restore = () => {
      config.implementation = previous;
      config.once = previousOnce;
    };
    try {
      const value = callback();
      if (
        value &&
        typeof (value as unknown as Promise<unknown>).then === "function"
      ) {
        return (value as unknown as Promise<unknown>).finally(
          restore,
        ) as ReturnType<typeof callback>;
      }
      restore();
      return value;
    } catch (error) {
      restore();
      throw error;
    }
  };
  mock.mockReturnThis = () =>
    mock.mockImplementation(function (this: unknown) {
      return this;
    } as T);
  mock.mockReturnValue = (value) => mock.mockImplementation((() => value) as T);
  mock.mockReturnValueOnce = (value) =>
    mock.mockImplementationOnce((() => value) as T);
  mock.mockResolvedValue = (value) =>
    mock.mockImplementation((() => Promise.resolve(value)) as T);
  mock.mockResolvedValueOnce = (value) =>
    mock.mockImplementationOnce((() => Promise.resolve(value)) as T);
  mock.mockRejectedValue = (value) =>
    mock.mockImplementation((() => Promise.reject(value)) as T);
  mock.mockRejectedValueOnce = (value) =>
    mock.mockImplementationOnce((() => Promise.reject(value)) as T);
  mock.mockClear = () => {
    context.calls.length = 0;
    context.instances.length = 0;
    context.contexts.length = 0;
    context.invocationCallOrder.length = 0;
    context.results.length = 0;
    return mock;
  };
  mock.mockReset = () => {
    mock.mockClear();
    config.implementation = undefined;
    config.once = [];
    config.name = "vi.fn()";
    return mock;
  };
  mock.mockRestore = () => {
    mock.mockReset();
    config.restore?.();
  };
  mock.mockName = (name: string) => {
    config.name = name;
    return mock;
  };
  mock.getMockName = () => config.name;

  REGISTERED_MOCKS.add(mock);
  MOCK_CONFIGS.set(mock, config);
  return mock;
}

export function spyOn<T extends object, K extends keyof T>(
  object: T,
  key: K,
  accessor?: "get" | "set",
): MockInstance {
  if (
    object == null ||
    (typeof object !== "object" && typeof object !== "function")
  ) {
    throw new Error("vi.spyOn() expects an object");
  }

  const descriptor = findPropertyDescriptor(object, key);
  if (!descriptor)
    throw new Error(`vi.spyOn() could not find property "${String(key)}"`);

  const [owner, originalDescriptor] = descriptor;
  const accessType = accessor ?? "value";
  const original =
    accessType === "value"
      ? originalDescriptor.value
      : originalDescriptor[accessType];

  if (accessType === "value" && typeof original !== "function") {
    throw new Error(
      `vi.spyOn() can only spy on functions; received ${typeof original}`,
    );
  }
  if (accessType !== "value" && typeof original !== "function") {
    throw new Error(
      `vi.spyOn() could not find a ${accessType}ter for property "${String(key)}"`,
    );
  }

  const restore = () => Object.defineProperty(owner, key, originalDescriptor);
  const mock = fn(typeof original === "function" ? original : undefined);
  const config = MOCK_CONFIGS.get(mock);
  if (config) {
    config.restore = restore;
    config.original = typeof original === "function" ? original : undefined;
    config.name = String(key);
  }

  const nextDescriptor: PropertyDescriptor = {
    ...originalDescriptor,
    configurable: true,
  };
  if (accessType === "get") nextDescriptor.get = mock;
  else if (accessType === "set") nextDescriptor.set = mock;
  else nextDescriptor.value = mock;
  Object.defineProperty(owner, key, nextDescriptor);
  return mock;
}

function findPropertyDescriptor<T extends object, K extends keyof T>(
  object: T,
  key: K,
): [object, PropertyDescriptor] | undefined {
  let cursor: object | null = object;
  while (cursor) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor) return [cursor, descriptor];
    cursor = Object.getPrototypeOf(cursor);
  }
  return undefined;
}

// ---- globals/env ------------------------------------------------------------

const STUBBED_GLOBALS = new Map<PropertyKey, PropertyDescriptor | undefined>();
const STUBBED_ENVS = new Map<string, string | undefined>();

/** `process` is absent in browser mode; env stubbing is a Node-only feature. */
function requireProcessEnv(caller: string): Record<string, string | undefined> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  if (!env) {
    throw new Error(
      `${caller} requires a Node environment with process.env (unavailable in browser mode)`,
    );
  }
  return env;
}

function stubGlobal(name: string | symbol, value: unknown): typeof vi {
  if (!STUBBED_GLOBALS.has(name)) {
    STUBBED_GLOBALS.set(
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    );
  }
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  return vi;
}

function unstubAllGlobals(): typeof vi {
  for (const [name, descriptor] of STUBBED_GLOBALS) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  STUBBED_GLOBALS.clear();
  return vi;
}

function stubEnv(
  name: string,
  value: string | number | boolean | undefined,
): typeof vi {
  const env = requireProcessEnv("vi.stubEnv()");
  if (!STUBBED_ENVS.has(name)) STUBBED_ENVS.set(name, env[name]);
  if (value === undefined) delete env[name];
  else env[name] = String(value);
  return vi;
}

function unstubAllEnvs(): typeof vi {
  // No-op when nothing was stubbed, so per-file cleanup stays safe in browsers.
  if (STUBBED_ENVS.size === 0) return vi;
  const env = requireProcessEnv("vi.unstubAllEnvs()");
  for (const [name, value] of STUBBED_ENVS) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  STUBBED_ENVS.clear();
  return vi;
}

// ---- fake timers ------------------------------------------------------------

type TimerCallback = (...args: unknown[]) => void;

interface TimerEntry {
  id: number;
  time: number;
  callback: TimerCallback;
  args: unknown[];
  interval?: number;
}

const ORIGINAL_TIMERS = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  Date: globalThis.Date,
};

let fakeTimersInstalled = false;
let fakeNow = Date.now();
let timerId = 1;
const timers = new Map<number, TimerEntry>();

function useFakeTimers(options: { now?: number | Date } = {}): typeof vi {
  if (fakeTimersInstalled) return vi;
  fakeTimersInstalled = true;
  fakeNow =
    options.now instanceof Date
      ? options.now.getTime()
      : (options.now ?? Date.now());

  globalThis.setTimeout = ((
    callback: TimerCallback,
    delay = 0,
    ...args: unknown[]
  ) => {
    const id = timerId++;
    timers.set(id, {
      id,
      time: fakeNow + Math.max(0, Number(delay) || 0),
      callback,
      args,
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    timers.delete(Number(id));
  }) as typeof clearTimeout;
  globalThis.setInterval = ((
    callback: TimerCallback,
    delay = 0,
    ...args: unknown[]
  ) => {
    const id = timerId++;
    const interval = Math.max(0, Number(delay) || 0);
    timers.set(id, { id, time: fakeNow + interval, callback, args, interval });
    return id as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = globalThis.clearTimeout as typeof clearInterval;

  const OriginalDate = ORIGINAL_TIMERS.Date;
  class FakeDate extends OriginalDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(fakeNow);
      else if (args.length === 1) super(args[0]);
      else
        super(
          Number(args[0]),
          Number(args[1]),
          args[2] === undefined ? 1 : Number(args[2]),
          args[3] === undefined ? 0 : Number(args[3]),
          args[4] === undefined ? 0 : Number(args[4]),
          args[5] === undefined ? 0 : Number(args[5]),
          args[6] === undefined ? 0 : Number(args[6]),
        );
    }
    static now() {
      return fakeNow;
    }
  }
  Object.setPrototypeOf(FakeDate, OriginalDate);
  globalThis.Date = FakeDate as DateConstructor;
  return vi;
}

function useRealTimers(): typeof vi {
  if (!fakeTimersInstalled) return vi;
  fakeTimersInstalled = false;
  timers.clear();
  globalThis.setTimeout = ORIGINAL_TIMERS.setTimeout;
  globalThis.clearTimeout = ORIGINAL_TIMERS.clearTimeout;
  globalThis.setInterval = ORIGINAL_TIMERS.setInterval;
  globalThis.clearInterval = ORIGINAL_TIMERS.clearInterval;
  globalThis.Date = ORIGINAL_TIMERS.Date;
  return vi;
}

function runDueTimers(target: number, onlyPending: boolean): void {
  const pending = onlyPending ? new Set(timers.keys()) : undefined;
  while (true) {
    let next: TimerEntry | undefined;
    for (const timer of timers.values()) {
      if (
        timer.time <= target &&
        (!pending || pending.has(timer.id)) &&
        (!next || timer.time < next.time)
      ) {
        next = timer;
      }
    }
    if (!next) break;
    fakeNow = next.time;
    timers.delete(next.id);
    next.callback(...next.args);
    if (next.interval !== undefined && (!pending || pending.has(next.id))) {
      next.time = fakeNow + next.interval;
      timers.set(next.id, next);
      if (onlyPending) pending?.delete(next.id);
    }
  }
  fakeNow = target;
}

function advanceTimersByTime(ms: number): typeof vi {
  runDueTimers(fakeNow + Math.max(0, ms), false);
  return vi;
}

function runAllTimers(): typeof vi {
  // setInterval reschedules itself, so the queue may never drain. Bound the run
  // (mirroring Vitest) instead of looping forever.
  let iterations = 0;
  while (timers.size > 0) {
    if (iterations++ >= 10_000) {
      throw new Error(
        "vi.runAllTimers() aborted after running 10000 timers; a setInterval likely never stops rescheduling",
      );
    }
    const nextTime = Math.min(
      ...[...timers.values()].map((timer) => timer.time),
    );
    runDueTimers(nextTime, false);
  }
  return vi;
}

function runOnlyPendingTimers(): typeof vi {
  runDueTimers(Number.POSITIVE_INFINITY, true);
  return vi;
}

function clearAllTimers(): typeof vi {
  timers.clear();
  return vi;
}

function setSystemTime(time: number | string | Date): typeof vi {
  fakeNow =
    time instanceof Date
      ? time.getTime()
      : typeof time === "string"
        ? new Date(time).getTime()
        : time;
  return vi;
}

// ---- module mocks -----------------------------------------------------------

type MockFactory = () => unknown | Promise<unknown>;

interface ModuleMockEntry {
  factory: MockFactory | undefined;
  module?: unknown;
}

const MODULE_MOCKS = new Map<string, ModuleMockEntry>();

function mockModule(id: string, factory?: MockFactory): typeof vi {
  MODULE_MOCKS.set(id, { factory });
  return vi;
}

async function importMock(id: string): Promise<unknown> {
  const entry = MODULE_MOCKS.get(id);
  if (!entry) throw new Error(`No mock registered for module "${id}"`);
  if (!("module" in entry))
    entry.module = entry.factory ? await entry.factory() : {};
  return entry.module;
}

async function importModule<T>(
  id: string,
  loader: () => Promise<T>,
): Promise<T> {
  if (MODULE_MOCKS.has(id)) return (await importMock(id)) as T;
  return loader();
}

function unmock(id: string): typeof vi {
  MODULE_MOCKS.delete(id);
  return vi;
}

function resetModules(): typeof vi {
  MODULE_MOCKS.clear();
  return vi;
}

async function importActual<T>(
  id: string,
  loader?: () => Promise<T>,
): Promise<T> {
  if (loader) return loader();
  return import(id) as Promise<T>;
}

// ---- public vi --------------------------------------------------------------

export const vi = {
  fn,
  spyOn,
  mocked: <T>(value: T): T => value,
  isMockFunction,
  clearAllMocks() {
    for (const mock of REGISTERED_MOCKS) mock.mockClear();
    return vi;
  },
  resetAllMocks() {
    for (const mock of REGISTERED_MOCKS) mock.mockReset();
    return vi;
  },
  restoreAllMocks() {
    for (const mock of REGISTERED_MOCKS) mock.mockRestore();
    return vi;
  },
  stubGlobal,
  unstubAllGlobals,
  stubEnv,
  unstubAllEnvs,
  useFakeTimers,
  useRealTimers,
  advanceTimersByTime,
  runAllTimers,
  runOnlyPendingTimers,
  clearAllTimers,
  setSystemTime,
  getMockedSystemTime: () => (fakeTimersInstalled ? new Date(fakeNow) : null),
  getRealSystemTime: () => ORIGINAL_TIMERS.Date.now(),
  mock: mockModule,
  doMock: mockModule,
  unmock,
  doUnmock: unmock,
  importMock,
  importActual,
  importModule,
  resetModules,
  hoisted: <T>(factory: () => T): T => factory(),
} as const;

export function cleanupViState(): void {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.resetModules();
  // Mocks are restored above; drop them so the registry doesn't grow across files.
  REGISTERED_MOCKS.clear();
}

// ---- transform plugin for basic vi.mock hoisting ---------------------------

function findViMockCalls(
  code: string,
): Array<{ start: number; end: number; text: string }> {
  const calls: Array<{ start: number; end: number; text: string }> = [];
  let index = 0;
  while (true) {
    const start = code.indexOf("vi.mock(", index);
    if (start === -1) break;
    let cursor = start + "vi.mock".length;
    let depth = 0;
    let quote: string | undefined;
    let escaped = false;
    for (; cursor < code.length; cursor++) {
      const char = code[cursor];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = undefined;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "(") depth++;
      else if (char === ")") {
        depth--;
        if (depth === 0) {
          cursor++;
          while (cursor < code.length && /\s/.test(code[cursor] ?? ""))
            cursor++;
          if (code[cursor] === ";") cursor++;
          calls.push({ start, end: cursor, text: code.slice(start, cursor) });
          index = cursor;
          break;
        }
      }
    }
    if (cursor >= code.length) break;
  }
  return calls;
}

function removeRanges(
  code: string,
  ranges: Array<{ start: number; end: number }>,
): string {
  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    result += code.slice(cursor, range.start);
    cursor = range.end;
  }
  result += code.slice(cursor);
  return result;
}

function namedImportsToDestructure(imports: string): string {
  return imports
    .slice(1, -1)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    // `import { type Foo, bar }` — type specifiers vanish at runtime, so they
    // must not become destructuring targets.
    .filter((part) => !/^type\s/.test(part))
    .map((part) => {
      const match = /^(\w+)\s+as\s+(\w+)$/.exec(part);
      return match ? `${match[1]}: ${match[2]}` : part;
    })
    .join(", ");
}

function importReplacement(
  clause: string,
  spec: string,
  counter: () => number,
): string {
  const load = `await __lightning_vi__.importModule(${JSON.stringify(spec)}, () => import(${JSON.stringify(spec)}))`;
  const trimmed = clause.trim();
  if (trimmed.startsWith("* as "))
    return `const ${trimmed.slice(5).trim()} = ${load};`;
  if (trimmed.startsWith("{"))
    return `const { ${namedImportsToDestructure(trimmed)} } = ${load};`;
  if (trimmed.includes(",")) {
    const [defaultPart, restPart] = trimmed
      .split(/,(.+)/, 2)
      .map((part) => part.trim());
    if (restPart?.startsWith("{")) {
      return `const { default: ${defaultPart}, ${namedImportsToDestructure(restPart)} } = ${load};`;
    }
    if (restPart?.startsWith("* as ")) {
      const temp = `__lightning_mock_mod_${counter()}`;
      return `const ${temp} = ${load}; const ${defaultPart} = ${temp}.default; const ${restPart.slice(5).trim()} = ${temp};`;
    }
  }
  return `const { default: ${trimmed} } = ${load};`;
}

function rewriteStaticImports(code: string): string {
  let tempCounter = 0;
  const nextTemp = () => tempCounter++;
  const fromImport =
    /^\s*import\s+(?!type\s)([^'";]+?)\s+from\s+(["'])([^"']+)\2\s*;?\s*$/gm;
  const sideEffectImport = /^\s*import\s+(["'])([^"']+)\1\s*;?\s*$/gm;

  let rewritten = code.replace(
    fromImport,
    (full, clause: string, _quote: string, spec: string) => {
      if (spec === "@lightning-js/lightning") return full;
      return importReplacement(clause, spec, nextTemp);
    },
  );
  rewritten = rewritten.replace(
    sideEffectImport,
    (full, _quote: string, spec: string) => {
      if (spec === "@lightning-js/lightning") return full;
      return `await __lightning_vi__.importModule(${JSON.stringify(spec)}, () => import(${JSON.stringify(spec)}));`;
    },
  );
  return rewritten;
}

export function createMockTransformPlugin(): NastiPlugin {
  return {
    name: "lightning:vi-mock-hoist",
    enforce: "pre",
    transform(code, id) {
      const cleanId = id.split("?")[0] ?? id;
      if (
        !/\.(test|spec)\.[cm]?[jt]sx?$/.test(cleanId) ||
        !code.includes("vi.mock(")
      )
        return null;
      const calls = findViMockCalls(code);
      if (calls.length === 0) return null;
      const withoutCalls = removeRanges(code, calls);
      const rewritten = rewriteStaticImports(withoutCalls);
      const hoisted = calls.map((call) =>
        call.text.replace(/^vi\./, "__lightning_vi__."),
      );
      return [
        'import { vi as __lightning_vi__ } from "@lightning-js/lightning";',
        ...hoisted,
        rewritten,
      ].join("\n");
    },
  };
}
