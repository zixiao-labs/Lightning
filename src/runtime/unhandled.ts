import type { TestError, TestResult } from "../types.ts";
import { getExecutionScope } from "./context.ts";

function toError(value: unknown, kind: string): TestError {
  const scope = getExecutionScope();
  const name = scope?.snapshotName;
  const prefix = `${kind}${name ? ` in "${name}"` : ""}: `;
  return value instanceof Error
    ? { message: prefix + value.message, ...(value.stack ? { stack: value.stack } : {}) }
    : { message: prefix + String(value) };
}

/** Scoped to one file; listeners are always removed before the next file. */
export function captureUnhandledErrors(): {
  errors: TestError[];
  drain(): Promise<void>;
  close(): void;
} {
  const errors: TestError[] = [];
  const rejection = (reason: unknown) => errors.push(toError(reason, "Unhandled rejection"));
  const exception = (error: Error) => errors.push(toError(error, "Uncaught exception"));
  process.on("unhandledRejection", rejection);
  process.on("uncaughtException", exception);
  return {
    errors,
    // Give Node a complete turn to emit rejected promises from the final test.
    drain: () => new Promise((resolve) => setImmediate(resolve)),
    close() {
      process.off("unhandledRejection", rejection);
      process.off("uncaughtException", exception);
    },
  };
}

export function unhandledErrorResults(errors: TestError[]): TestResult[] {
  return errors.map((error, index) => ({
    fullName: `Unhandled error ${index + 1}`,
    state: "fail",
    durationMs: 0,
    error,
  }));
}
