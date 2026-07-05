import type { FileResult, RunSummary } from "../types.ts";

export function createRunSummary(files: FileResult[], durationMs: number): RunSummary {
  const summary: RunSummary = {
    totalFiles: files.length,
    failedFiles: files.filter((f) => f.error || f.results.some((r) => r.state === "fail")).length,
    passedTests: 0,
    failedTests: 0,
    skippedTests: 0,
    todoTests: 0,
    durationMs,
  };
  for (const f of files) {
    for (const r of f.results) {
      if (r.state === "pass") summary.passedTests++;
      else if (r.state === "fail") summary.failedTests++;
      else if (r.state === "skip") summary.skippedTests++;
      else if (r.state === "todo") summary.todoTests++;
    }
  }
  return summary;
}
