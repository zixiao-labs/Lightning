/**
 * Default reporter: a Vitest-style spec view.
 *
 *   ⚡ banner → per-file ✓/✗ lines → failure blocks (message + diff + clean stack)
 *   → summary (files / tests, duration).
 *
 * ⚡️ is the only Lightning-specific flair; everything else mirrors Vitest's wording.
 */
import path from "node:path";
import c from "tinyrainbow";
import type { FileResult, TaskState, TestResult } from "../types.ts";

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
  onStart(fileCount: number, root: string): void;
  onFileDone(file: FileResult): void;
  /** Print the final summary and return the aggregate stats. */
  onFinished(files: FileResult[]): RunSummary;
}

export interface ReporterOptions {
  root: string;
}

const STATE_GLYPH: Record<TaskState, string> = {
  pass: c.green("✓"),
  fail: c.red("✗"),
  skip: c.yellow("↓"),
  todo: c.dim("○"),
};

function rel(root: string, file: string): string {
  const r = path.relative(root, file);
  return r.split(path.sep).join("/");
}

function indentLines(text: string, indent: string): string {
  return text
    .split("\n")
    .map((l) => indent + l)
    .join("\n");
}

/** Strip Lightning/Nasti internals and node-internal frames from a stack. */
function cleanStack(stack: string | undefined): string {
  if (!stack) return "";
  return stack
    .split("\n")
    .filter((line) => {
      if (!/^\s*at /.test(line)) return true;
      return !/node:internal|@nasti-toolchain|\/lightning\/dist\/|node_modules/.test(line);
    })
    .join("\n");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `${value}n`;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function createDefaultReporter(opts: ReporterOptions): Reporter {
  const start = performance.now();
  const failures: Array<{ file: string; result?: TestResult; fileError?: FileResult["error"] }> = [];

  return {
    onStart(fileCount) {
      // ⚡️ banner — Lightning branding.
      const tag = c.bold(c.yellow("⚡️ Lightning"));
      console.log(`\n${tag} ${c.dim(`running ${fileCount} test file${fileCount === 1 ? "" : "s"}`)}\n`);
    },

    onFileDone(file) {
      const name = rel(opts.root, file.filepath);

      if (file.error) {
        console.log(`${c.red("✗")} ${c.red(name)} ${c.dim("(failed to load)")}`);
        failures.push({ file: name, fileError: file.error });
        return;
      }

      const failed = file.results.filter((r) => r.state === "fail").length;
      const head = failed > 0 ? c.red("✗") : c.green("✓");
      console.log(`${head} ${c.dim(name)}`);

      for (const r of file.results) {
        const leaf = r.fullName.split(" > ").join(c.dim(" › "));
        const suffix = r.state === "todo" ? c.dim(" [todo]") : r.state === "skip" ? c.dim(" [skipped]") : "";
        const dur = r.state === "pass" && r.durationMs >= 1 ? c.dim(` ${Math.round(r.durationMs)}ms`) : "";
        console.log(`  ${STATE_GLYPH[r.state]} ${leaf}${suffix}${dur}`);
        if (r.state === "fail") failures.push({ file: name, result: r });
      }
    },

    onFinished(files) {
      const summary: RunSummary = {
        totalFiles: files.length,
        failedFiles: files.filter((f) => f.error || f.results.some((r) => r.state === "fail")).length,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        todoTests: 0,
        durationMs: performance.now() - start,
      };
      for (const f of files) {
        for (const r of f.results) {
          if (r.state === "pass") summary.passedTests++;
          else if (r.state === "fail") summary.failedTests++;
          else if (r.state === "skip") summary.skippedTests++;
          else if (r.state === "todo") summary.todoTests++;
        }
      }

      if (failures.length > 0) {
        console.log(`\n${c.bold(c.red("Failures:"))}\n`);
        failures.forEach((f, i) => {
          const title = f.result ? f.result.fullName : `${f.file} (load error)`;
          console.log(`${c.red(`${i + 1})`)} ${c.bold(title)}  ${c.dim(c.gray(f.file))}`);
          const err = f.result?.error ?? f.fileError;
          if (err) {
            console.log(indentLines(c.red(err.message), "   "));
            if (err.diff) {
              console.log(`${c.dim("   - expected")} ${c.green(formatValue(err.diff.expected))}`);
              console.log(`${c.dim("   + received")} ${c.red(formatValue(err.diff.actual))}`);
            }
            const stack = cleanStack(err.stack);
            if (stack) console.log(indentLines(c.dim(stack), "   "));
          }
          console.log("");
        });
      }

      const fileLine = `${c.dim("Test Files")}  ${
        summary.failedFiles > 0 ? c.red(`${summary.failedFiles} failed`) + c.dim(" | ") : ""
      }${c.green(`${summary.totalFiles - summary.failedFiles} passed`)} ${c.dim(`(${summary.totalFiles})`)}`;

      const parts: string[] = [];
      if (summary.failedTests > 0) parts.push(c.red(`${summary.failedTests} failed`));
      parts.push(c.green(`${summary.passedTests} passed`));
      if (summary.skippedTests > 0) parts.push(c.yellow(`${summary.skippedTests} skipped`));
      if (summary.todoTests > 0) parts.push(c.dim(`${summary.todoTests} todo`));
      const total = summary.passedTests + summary.failedTests + summary.skippedTests + summary.todoTests;
      const testLine = `${c.dim("     Tests")}  ${parts.join(c.dim(" | "))} ${c.dim(`(${total})`)}`;

      const durLine = `${c.dim("  Duration")}  ${Math.round(summary.durationMs)}ms`;

      console.log(`${fileLine}\n${testLine}\n${durLine}\n`);

      if (summary.failedFiles > 0 || summary.failedTests > 0) {
        console.log(c.bold(c.red("⚡️ test run failed")) + "\n");
      } else if (summary.totalFiles === 0) {
        console.log(c.yellow("⚡️ no test files found") + "\n");
      } else {
        console.log(c.bold(c.green("⚡️ all tests passed")) + "\n");
      }

      return summary;
    },
  };
}
