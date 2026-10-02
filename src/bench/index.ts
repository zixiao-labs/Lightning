import type { BenchOptions } from "tinybench";

export type BenchmarkOptions = Pick<BenchOptions, "time" | "iterations" | "warmup" | "warmupTime" | "warmupIterations">;
export interface BenchmarkTask {
  name: string;
  fn: () => void | Promise<void>;
  mode: "run" | "skip" | "only";
  options: BenchmarkOptions;
}
interface Collection {
  tasks: BenchmarkTask[];
  suites: { name: string; mode: BenchmarkTask["mode"] }[];
}
// SSR can load a second copy of Lightning. A process-wide symbol makes imports
// from the public package and the runner share precisely one active collector.
const key = Symbol.for("lightning.benchmark.collector");
const global = globalThis as typeof globalThis & { [key]?: Collection };
export function startBenchmarkCollection(): void {
  global[key] = { tasks: [], suites: [] };
}
export function finishBenchmarkCollection(): BenchmarkTask[] {
  const tasks = global[key]?.tasks ?? [];
  delete global[key];
  return tasks;
}
function register(mode: BenchmarkTask["mode"], name: string, fn: BenchmarkTask["fn"], options: BenchmarkOptions = {}): void {
  const collection = global[key];
  if (!collection) throw new Error("bench() must be called while collecting a benchmark file");
  const modes = [...collection.suites.map((suite) => suite.mode), mode];
  collection.tasks.push({
    name: [...collection.suites.map((suite) => suite.name), name].join(" > "),
    fn, options,
    mode: modes.includes("skip") ? "skip" : modes.includes("only") ? "only" : "run",
  });
}
export const bench = Object.assign(
  (name: string, fn: BenchmarkTask["fn"], options?: BenchmarkOptions) => register("run", name, fn, options),
  {
    skip: (name: string, fn: BenchmarkTask["fn"], options?: BenchmarkOptions) => register("skip", name, fn, options),
    only: (name: string, fn: BenchmarkTask["fn"], options?: BenchmarkOptions) => register("only", name, fn, options),
  },
);
function suite(mode: BenchmarkTask["mode"], name: string, fn: () => void): void {
  const collection = global[key];
  if (!collection) throw new Error("describe.bench() must be called while collecting a benchmark file");
  collection.suites.push({ name, mode });
  try { fn(); } finally { collection.suites.pop(); }
}
export const describeBench = Object.assign(
  (name: string, fn: () => void) => suite("run", name, fn),
  {
    skip: (name: string, fn: () => void) => suite("skip", name, fn),
    only: (name: string, fn: () => void) => suite("only", name, fn),
  },
);
