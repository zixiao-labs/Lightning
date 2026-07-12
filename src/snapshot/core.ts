/**
 * Snapshot core: in-memory session state, serialization and matching.
 *
 * Deliberately free of Node imports so it can ship inside the browser runtime
 * bundle. File IO lives at the session boundaries and is owned by the host:
 * the Node file-runner reads/writes `.snap` files around a session
 * (`../snapshot/index.ts`), while browser mode seeds the session with data read
 * by the orchestrator and posts the updated data back over the result channel.
 */
import { inspect } from "../utils/inspect.ts";

export interface SnapshotSerializer {
  test(value: unknown): boolean;
  serialize(value: unknown): string;
}

interface SnapshotSessionState {
  update: boolean;
  data: Record<string, string>;
  counters: Map<string, number>;
  dirty: boolean;
  currentTestName?: string;
}

const serializers: SnapshotSerializer[] = [];
let state: SnapshotSessionState | undefined;

export function addSnapshotSerializer(serializer: SnapshotSerializer): void {
  serializers.unshift(serializer);
}

export function getSerializers(): SnapshotSerializer[] {
  return [...serializers];
}

export interface SnapshotSessionOptions {
  /** Previously stored snapshot entries for the current test file. */
  data: Record<string, string>;
  /** Overwrite mismatched snapshots instead of failing (`--update`). */
  update: boolean;
}

export function startSnapshotSession(options: SnapshotSessionOptions): void {
  state = {
    update: options.update,
    data: { ...options.data },
    counters: new Map(),
    dirty: false,
  };
}

export interface SnapshotSessionResult {
  data: Record<string, string>;
  dirty: boolean;
}

/** Close the session and return its (possibly updated) entries. */
export function finishSnapshotSession(): SnapshotSessionResult | undefined {
  if (!state) return undefined;
  const result = { data: state.data, dirty: state.dirty };
  state = undefined;
  return result;
}

export function setCurrentSnapshotTest(testName: string | undefined): void {
  if (!state) return;
  if (testName === undefined) delete state.currentTestName;
  else state.currentTestName = testName;
}

export function serializeSnapshot(value: unknown): string {
  for (const serializer of serializers) {
    if (serializer.test(value)) return serializer.serialize(value);
  }
  if (typeof value === "string") return value;
  return inspect(value, {
    colors: false,
    depth: Number.POSITIVE_INFINITY,
    maxArrayLength: Number.POSITIVE_INFINITY,
    sorted: true,
  });
}

function keyFor(hint?: string): string {
  if (!state?.currentTestName) {
    throw new Error("Snapshot matcher was called outside of a running test");
  }
  const base = hint ? `${state.currentTestName}: ${hint}` : state.currentTestName;
  const count = (state.counters.get(base) ?? 0) + 1;
  state.counters.set(base, count);
  return `${base} ${count}`;
}

export interface SnapshotMatchResult {
  pass: boolean;
  key: string;
  actual: string;
  expected?: string;
}

export function matchSnapshot(value: unknown, hint?: string): SnapshotMatchResult {
  if (!state) throw new Error("Snapshot matcher was called before snapshot state was initialized");
  const key = keyFor(hint);
  const actual = serializeSnapshot(value);
  const expected = state.data[key];

  if (expected === undefined) {
    state.data[key] = actual;
    state.dirty = true;
    return { pass: true, key, actual };
  }

  if (expected === actual) return { pass: true, key, actual, expected };

  if (state.update) {
    state.data[key] = actual;
    state.dirty = true;
    return { pass: true, key, actual, expected };
  }

  return { pass: false, key, actual, expected };
}
