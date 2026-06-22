import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

export interface SnapshotSerializer {
  test(value: unknown): boolean;
  serialize(value: unknown): string;
}

interface SnapshotFileState {
  filepath: string;
  snapshotPath: string;
  update: boolean;
  data: Record<string, string>;
  counters: Map<string, number>;
  dirty: boolean;
  currentTestName?: string;
}

const serializers: SnapshotSerializer[] = [];
let state: SnapshotFileState | undefined;

export function addSnapshotSerializer(serializer: SnapshotSerializer): void {
  serializers.unshift(serializer);
}

export function getSerializers(): SnapshotSerializer[] {
  return [...serializers];
}

function snapshotPathFor(testFile: string, snapshotDir: string): string {
  return path.join(path.dirname(testFile), snapshotDir, `${path.basename(testFile)}.snap`);
}

function readSnapshotFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf-8");
  const json = raw.replace(/^\/\/ Lightning Snapshot v1\n?/, "").trim();
  if (!json) return {};
  return JSON.parse(json) as Record<string, string>;
}

export function startSnapshotFile(options: {
  testFile: string;
  snapshotDir: string;
  update: boolean;
}): void {
  const snapshotPath = snapshotPathFor(options.testFile, options.snapshotDir);
  state = {
    filepath: options.testFile,
    snapshotPath,
    update: options.update,
    data: readSnapshotFile(snapshotPath),
    counters: new Map(),
    dirty: false,
  };
}

export function setCurrentSnapshotTest(testName: string | undefined): void {
  if (!state) return;
  if (testName === undefined) delete state.currentTestName;
  else state.currentTestName = testName;
}

export function finishSnapshotFile(): void {
  if (!state) return;
  if (state.dirty) {
    mkdirSync(path.dirname(state.snapshotPath), { recursive: true });
    const body = JSON.stringify(state.data, null, 2);
    writeFileSync(state.snapshotPath, `// Lightning Snapshot v1\n${body}\n`);
  }
  state = undefined;
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
