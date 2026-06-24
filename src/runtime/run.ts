/**
 * Runner: walks a collected suite tree and produces results.
 *
 * Hook semantics mirror Jest/Vitest:
 *  - `beforeAll`/`afterAll` run once per suite (before/after its tasks),
 *  - `beforeEach` run outer→inner before every test, `afterEach` inner→outer after.
 */
import type { Suite, Test, TestError, TestResult } from "../types.ts";
import { finishTestAssertions, startTestAssertions } from "../expect/index.ts";

export interface RunOptions {
  hasOnly: boolean;
  defaultTimeout: number;
  /** Only run tests whose full dotted name matches. */
  namePattern?: RegExp;
  retry: number;
  repeats: number;
  onTestStart?: (name: string) => void;
  onTestEnd?: (name: string) => void | Promise<void>;
}

function toError(value: unknown): TestError {
  if (value instanceof Error) {
    const err: TestError = { message: value.message, stack: value.stack ?? "" };
    const diff = (value as { diff?: TestError["diff"] }).diff;
    if (diff) err.diff = diff;
    return err;
  }
  return { message: typeof value === "string" ? value : String(value) };
}

function withTimeout(
  fn: () => void | Promise<void>,
  ms: number,
  label: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out in ${ms}ms`));
    }, ms);
    Promise.resolve()
      .then(fn)
      .then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
  });
}

function suitePath(suite: Suite): string[] {
  const parts: string[] = [];
  let s: Suite | null = suite;
  while (s && s.name) {
    parts.unshift(s.name);
    s = s.parent;
  }
  return parts;
}

function fullName(test: Test): string {
  return [...suitePath(test.suite), test.name].join(" > ");
}

function suiteName(suite: Suite): string {
  return suitePath(suite).join(" > ") || "<root>";
}

function hasActiveTest(
  suite: Suite,
  inOnly: boolean,
  opts: RunOptions,
): boolean {
  for (const task of suite.tasks) {
    if (task.type === "test") {
      if (isTestActive(task, inOnly, opts)) return true;
    } else {
      const childInOnly = inOnly || task.mode === "only";
      if (
        task.mode !== "skip" &&
        task.mode !== "todo" &&
        hasActiveTest(task, childInOnly, opts)
      ) {
        return true;
      }
    }
  }
  return false;
}

function isTestActive(test: Test, inOnly: boolean, opts: RunOptions): boolean {
  if (opts.hasOnly && !(inOnly || test.mode === "only")) return false;
  if (opts.namePattern) {
    opts.namePattern.lastIndex = 0;
    if (!opts.namePattern.test(fullName(test))) return false;
  }
  return true;
}

export async function runSuiteTree(
  root: Suite,
  opts: RunOptions,
): Promise<TestResult[]> {
  return runSuite(root, opts, [], [], false, false);
}

async function runSuite(
  suite: Suite,
  opts: RunOptions,
  beforeEachChain: Array<() => void | Promise<void>>,
  afterEachChain: Array<() => void | Promise<void>>,
  inOnly: boolean,
  inheritedConcurrent: boolean,
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const active = hasActiveTest(suite, inOnly, opts);
  const suiteConcurrent = suite.sequential
    ? false
    : (suite.concurrent ?? inheritedConcurrent);

  const beforeEach = [
    ...beforeEachChain,
    ...suite.hooks.filter((h) => h.type === "beforeEach").map((h) => h.fn),
  ];
  const afterEach = [
    ...suite.hooks.filter((h) => h.type === "afterEach").map((h) => h.fn),
    ...afterEachChain,
  ];

  if (active) {
    try {
      for (const h of suite.hooks.filter((h) => h.type === "beforeAll"))
        await h.fn();
    } catch (error) {
      return markFailedActive(suite, opts, inOnly, toError(error));
    }
  }

  const concurrentQueue: Array<Promise<TestResult[]>> = [];
  const flushConcurrent = async () => {
    if (concurrentQueue.length === 0) return;
    const chunks = await Promise.all(concurrentQueue.splice(0));
    for (const chunk of chunks) results.push(...chunk);
  };

  for (const task of suite.tasks) {
    if (task.type === "suite") {
      await flushConcurrent();
      const childInOnly = inOnly || task.mode === "only";
      if (task.mode === "skip" || task.mode === "todo") {
        results.push(
          ...markSkipped(task, task.mode === "todo" ? "todo" : "skip"),
        );
        continue;
      }
      results.push(
        ...(await runSuite(
          task,
          opts,
          beforeEach,
          afterEach,
          childInOnly,
          suiteConcurrent,
        )),
      );
    } else {
      const testConcurrent = task.sequential
        ? false
        : (task.concurrent ?? suiteConcurrent);
      const run = () => runTest(task, opts, beforeEach, afterEach, inOnly);
      if (testConcurrent) concurrentQueue.push(run());
      else {
        await flushConcurrent();
        results.push(...(await run()));
      }
    }
  }

  await flushConcurrent();

  if (active) {
    for (const h of suite.hooks.filter((h) => h.type === "afterAll")) {
      try {
        await h.fn();
      } catch (error) {
        results.push({
          fullName: `${suiteName(suite)} > afterAll`,
          state: "fail",
          durationMs: 0,
          error: toError(error),
        });
      }
    }
  }

  return results;
}

function markSkipped(suite: Suite, state: "skip" | "todo"): TestResult[] {
  const results: TestResult[] = [];
  for (const task of suite.tasks) {
    if (task.type === "test")
      results.push({ fullName: fullName(task), state, durationMs: 0 });
    else results.push(...markSkipped(task, state));
  }
  return results;
}

function markFailedActive(
  suite: Suite,
  opts: RunOptions,
  inOnly: boolean,
  error: TestError,
): TestResult[] {
  const results: TestResult[] = [];
  for (const task of suite.tasks) {
    if (task.type === "test") {
      if (isTestActive(task, inOnly, opts)) {
        results.push({
          fullName: fullName(task),
          state: "fail",
          durationMs: 0,
          error,
        });
      } else {
        results.push({
          fullName: fullName(task),
          state: "skip",
          durationMs: 0,
        });
      }
    } else {
      const childInOnly = inOnly || task.mode === "only";
      results.push(...markFailedActive(task, opts, childInOnly, error));
    }
  }
  return results;
}

async function runTest(
  test: Test,
  opts: RunOptions,
  beforeEach: Array<() => void | Promise<void>>,
  afterEach: Array<() => void | Promise<void>>,
  inOnly: boolean,
): Promise<TestResult[]> {
  const name = fullName(test);

  if (test.mode === "todo")
    return [{ fullName: name, state: "todo", durationMs: 0 }];
  if (test.mode === "skip" || !isTestActive(test, inOnly, opts)) {
    return [{ fullName: name, state: "skip", durationMs: 0 }];
  }

  const repeats = Math.max(1, test.repeats ?? opts.repeats);
  const output: TestResult[] = [];
  for (let repeatIndex = 1; repeatIndex <= repeats; repeatIndex++) {
    const displayName =
      repeats === 1 ? name : `${name} [repeat ${repeatIndex}/${repeats}]`;
    output.push(
      await runWithRetry(
        test,
        displayName,
        opts,
        beforeEach,
        afterEach,
        repeatIndex,
      ),
    );
  }
  return output;
}

async function runWithRetry(
  test: Test,
  displayName: string,
  opts: RunOptions,
  beforeEach: Array<() => void | Promise<void>>,
  afterEach: Array<() => void | Promise<void>>,
  repeatIndex: number,
): Promise<TestResult> {
  const retry = Math.max(0, test.retry ?? opts.retry);
  let last: TestResult | undefined;
  for (let attempt = 0; attempt <= retry; attempt++) {
    const result = await runAttempt(
      test,
      displayName,
      opts,
      beforeEach,
      afterEach,
      repeatIndex,
      attempt,
    );
    if (result.state === "pass") return result;
    last = result;
  }
  return (
    last ?? {
      fullName: displayName,
      state: "fail",
      durationMs: 0,
      retryCount: retry,
    }
  );
}

async function runAttempt(
  test: Test,
  displayName: string,
  opts: RunOptions,
  beforeEach: Array<() => void | Promise<void>>,
  afterEach: Array<() => void | Promise<void>>,
  repeatIndex: number,
  attempt: number,
): Promise<TestResult> {
  const timeout = test.timeout ?? opts.defaultTimeout;
  const start = performance.now();
  let afterEachStarted = false;

  startTestAssertions();
  opts.onTestStart?.(displayName);
  try {
    for (const fn of beforeEach) await withTimeout(fn, timeout, "BeforeEach");
    await withTimeout(test.fn, timeout, "Test");
    afterEachStarted = true;
    for (const fn of afterEach) await withTimeout(fn, timeout, "AfterEach");
    finishTestAssertions();
    await opts.onTestEnd?.(displayName);
    return {
      fullName: displayName,
      state: "pass",
      durationMs: performance.now() - start,
      ...(attempt > 0 ? { retryCount: attempt } : {}),
      ...(repeatIndex > 1 ? { repeatIndex } : {}),
    };
  } catch (err) {
    if (!afterEachStarted) {
      for (const fn of afterEach) {
        try {
          await withTimeout(fn, timeout, "AfterEach");
        } catch {
          /* preserve the primary failure */
        }
      }
    }
    await opts.onTestEnd?.(displayName);
    return {
      fullName: displayName,
      state: "fail",
      durationMs: performance.now() - start,
      error: toError(err),
      ...(attempt > 0 ? { retryCount: attempt } : {}),
      ...(repeatIndex > 1 ? { repeatIndex } : {}),
    };
  }
}
