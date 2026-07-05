/**
 * Shared types for Lightning's test layer.
 *
 * The collector builds a tree of {@link Suite} / {@link Test} nodes (a "task tree"),
 * the runner walks it producing {@link TestResult}s, and the reporter renders them.
 */
import type { NastiConfig } from "@nasti-toolchain/nasti";

/** How a task was marked at collection time. */
export type TaskMode = "run" | "skip" | "todo" | "only";

/** Final state of an executed task. */
export type TaskState = "pass" | "fail" | "skip" | "todo";

/** Supported execution pools. */
export type TestPool = "threads" | "forks" | "inline";

/** Runtime environment installed before a test file is evaluated. */
export type TestEnvironment = "node" | "jsdom" | "happy-dom" | "edge-runtime";

/** Built-in reporter names. Custom strings are resolved as reporter module ids. */
export type BuiltinReporter =
  | "default"
  | "verbose"
  | "dot"
  | "json"
  | "junit"
  | "tap"
  | "github-actions";

export type ReporterConfig = BuiltinReporter | string | Reporter;

export interface PoolOptions {
  /** Maximum number of files executing at once. Defaults to `max(1, cpus - 1)`. */
  maxWorkers?: number;
}

export interface CoverageThresholds {
  lines?: number;
  functions?: number;
  branches?: number;
  statements?: number;
}

export interface V8CoverageRange {
  startOffset: number;
  endOffset: number;
  count: number;
}

export interface V8CoverageFunction {
  functionName: string;
  ranges: V8CoverageRange[];
  isBlockCoverage: boolean;
}

export interface V8CoverageScript {
  scriptId: string;
  url: string;
  functions: V8CoverageFunction[];
}

export type CoverageProvider = "v8";
export type CoverageReporter = "text" | "html" | "lcov" | "json";

export interface CoverageOptions {
  /** Enable coverage collection. Can also be enabled with `--coverage`. */
  enabled?: boolean;
  /** Coverage provider. Phase 4 starts with V8 provider semantics. */
  provider?: CoverageProvider;
  /** Reporters to emit. Defaults to `["text"]`. */
  reporter?: CoverageReporter[];
  /** Output directory for file-based reports. Default `coverage`. */
  reportsDirectory?: string;
  /** Globs of source files to include in reports. */
  include?: string[];
  /** Globs of files to exclude from reports. */
  exclude?: string[];
  /** Minimum required percentages. */
  thresholds?: CoverageThresholds;
}

export interface ShardOptions {
  /** 1-based shard index. */
  index: number;
  /** Total shard count. */
  count: number;
}

export interface ProjectConfig extends NastiConfig {
  /** Optional display name used by reporters. */
  name?: string;
  test?: TestOptions;
}

export interface Hook {
  type: "beforeAll" | "afterAll" | "beforeEach" | "afterEach";
  fn: () => void | Promise<void>;
}

export interface RunnableOptions {
  /** Run this suite/test in the concurrent lane when possible. */
  concurrent?: boolean;
  /** Force sequential execution even under a concurrent parent suite. */
  sequential?: boolean;
  /** Per-test timeout in ms (falls back to the suite/config default). */
  timeout?: number;
  /** Number of retries after a failing attempt. */
  retry?: number;
  /** Number of times to repeat the test. */
  repeats?: number;
}

export interface Test extends RunnableOptions {
  type: "test";
  name: string;
  mode: TaskMode;
  fn: () => void | Promise<void>;
  suite: Suite;
}

export interface Suite extends RunnableOptions {
  type: "suite";
  /** Empty string for the implicit file-root suite. */
  name: string;
  mode: TaskMode;
  /** null for the file-root suite. */
  parent: Suite | null;
  tasks: Array<Suite | Test>;
  hooks: Hook[];
}

export type Task = Suite | Test;

export interface TestResult {
  /** Full dotted path, e.g. `math > adds > handles negatives`. */
  fullName: string;
  state: TaskState;
  durationMs: number;
  error?: TestError;
  /** Number of failed attempts before the final passing/failing result. */
  retryCount?: number;
  /** 1-based repeat index when a repeated test emits multiple results. */
  repeatIndex?: number;
}

export interface TestError {
  message: string;
  stack?: string;
  /** Present for assertion errors so the reporter can render a diff. */
  diff?: { actual: unknown; expected: unknown };
}

/** Aggregated outcome for a single test file. */
export interface FileResult {
  /** Absolute path to the spec file. */
  filepath: string;
  results: TestResult[];
  /** A collection/import-time error (file failed before any test ran). */
  error?: TestError;
  durationMs: number;
  /** Environment active while this file ran. */
  environment?: TestEnvironment;
  /** Project display name when running a multi-project config. */
  projectName?: string;
  /** Raw V8 script coverage collected for this file, when coverage is enabled. */
  coverage?: V8CoverageScript[];
}

export interface RunSummary {
  totalFiles: number;
  failedFiles: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  todoTests: number;
  durationMs: number;
}

export interface Reporter {
  onStart?(fileCount: number, root: string): void | Promise<void>;
  onFileDone?(file: FileResult): void | Promise<void>;
  /** Print/emit the final summary and optionally return aggregate stats. */
  onFinished?(files: FileResult[], summary: RunSummary): void | Promise<void>;
}

/** Lightning-specific test options layered on top of the Nasti config. */
export interface TestOptions {
  /** Glob(s) for discovering spec files. */
  include?: string[];
  /** Glob(s) excluded from discovery. */
  exclude?: string[];
  /** Inject `test`/`expect`/... onto `globalThis` (Vitest `globals`). Default false. */
  globals?: boolean;
  /** Default per-test timeout in ms. Default 5000. */
  testTimeout?: number;
  /** Only run tests whose full name matches this substring/pattern. */
  testNamePattern?: string | RegExp;
  /** Reporter ids or custom reporter instances. */
  reporters?: ReporterConfig[];
  /** Execution pool. Defaults to worker threads. */
  pool?: TestPool;
  /** Worker pool options. */
  poolOptions?: PoolOptions;
  /** File-level process/thread isolation. Default true. */
  isolate?: boolean;
  /** Default retry count for failing tests. */
  retry?: number;
  /** Default repeat count for tests. */
  repeats?: number;
  /** Update mismatched snapshots. */
  update?: boolean;
  /** Directory name for colocated snapshots. Default `__snapshots__`. */
  snapshotDir?: string;
  /** Runtime environment for test files. Default `node`. */
  environment?: TestEnvironment;
  /** V8/Istanbul-compatible coverage options. */
  coverage?: CoverageOptions;
  /** CI sharding, e.g. `{ index: 1, count: 4 }` for `--shard=1/4`. */
  shard?: ShardOptions;
}

/** User-facing Lightning config: a Nasti config with a `test` block. */
export interface LightningConfig extends NastiConfig {
  test?: TestOptions;
  /** Multi-project config. Each project is resolved and run with inherited defaults. */
  projects?: ProjectConfig[];
}

/** Fully-resolved config the orchestrator runs against. */
export interface ResolvedLightningConfig {
  root: string;
  include: string[];
  exclude: string[];
  globals: boolean;
  testTimeout: number;
  testNamePattern?: RegExp;
  reporters: ReporterConfig[];
  pool: TestPool;
  poolOptions: Required<PoolOptions>;
  isolate: boolean;
  retry: number;
  repeats: number;
  updateSnapshots: boolean;
  snapshotDir: string;
  environment: TestEnvironment;
  coverage: Required<Omit<CoverageOptions, "thresholds">> & {
    thresholds?: CoverageThresholds;
  };
  shard?: ShardOptions;
  projectName?: string;
  /** The inline Nasti config forwarded to `createServer`. */
  nasti: NastiConfig;
}
