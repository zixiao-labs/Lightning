import { Bench } from "tinybench";
import type { BenchmarkOptions } from "./index.ts";

export type ContextBenchmarkResult = Extract<Bench["tasks"][number]["result"], { state: "completed" }>;
export interface BenchmarkDescriptor {
  name: string;
  run(): Promise<ContextBenchmarkResult>;
}
export interface BenchmarkContext {
  (name: string, fn: () => void | Promise<void>, options?: BenchmarkOptions): BenchmarkDescriptor;
  (name: string, options: BenchmarkOptions, fn: () => void | Promise<void>): BenchmarkDescriptor;
  compare(...benchmarks: BenchmarkDescriptor[]): Promise<Map<string, ContextBenchmarkResult>>;
}

/** Per-test fixture; never stores measurements in the top-level collector. */
export function createBenchmarkContext(
  onResult?: (name: string, result: ContextBenchmarkResult) => void,
): BenchmarkContext {
  const create = (
    name: string,
    fnOrOptions: BenchmarkOptions | (() => void | Promise<void>),
    optionsOrFn?: BenchmarkOptions | (() => void | Promise<void>),
  ): BenchmarkDescriptor => {
    const fn = typeof fnOrOptions === "function" ? fnOrOptions : optionsOrFn;
    const options = typeof fnOrOptions === "function" ? optionsOrFn : fnOrOptions;
    if (typeof fn !== "function") throw new TypeError("Benchmark callback must be a function");
    return {
      name,
      async run() {
        const runner = new Bench({ ...(typeof options === "object" ? options : {}), throws: true });
        runner.add(name, fn);
        await runner.run();
        const result = runner.tasks[0]?.result;
        if (!result || result.state !== "completed") throw new Error(`Benchmark ${name} did not complete`);
        onResult?.(name, result);
        return result;
      },
    };
  };
  return Object.assign(create, {
    async compare(...benchmarks: BenchmarkDescriptor[]) {
      const results = new Map<string, ContextBenchmarkResult>();
      if (new Set(benchmarks.map((benchmark) => benchmark.name)).size !== benchmarks.length) {
        throw new Error("Benchmark comparison names must be unique");
      }
      for (const benchmark of benchmarks) results.set(benchmark.name, await benchmark.run());
      return results;
    },
  });
}
