/** Vitest-style default reporter. */
import path from "node:path";
import c from "tinyrainbow";
import type { FileResult, Reporter, RunSummary, TaskState, TestResult } from "../types.ts";

export interface ReporterOptions { root: string }

const STATE_GLYPH: Record<TaskState, string> = {
  pass: c.green("✓"),
  fail: c.red("✗"),
  skip: c.yellow("↓"),
  todo: c.dim("○"),
};

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function indentLines(text: string, indent: string): string {
  return text.split("\n").map((l) => indent + l).join("\n");
}

function cleanStack(stack: string | undefined): string {
  if (!stack) return "";
  return stack
    .split("\n")
    .filter((line) => !/^\s*at /.test(line) || !/node:internal|@nasti-toolchain|\/lightning\/dist\/|node_modules/.test(line))
    .join("\n");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `${value}n`;
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
}

function fileLabel(opts: ReporterOptions, file: FileResult): string {
  const name = rel(opts.root, file.filepath);
  return file.projectName ? `[${file.projectName}] ${name}` : name;
}

export function createDefaultReporter(opts: ReporterOptions): Reporter {
  const failures: Array<{ file: string; result?: TestResult; fileError?: FileResult["error"] }> = [];

  return {
    onStart(fileCount) {
      const tag = c.bold(c.yellow("⚡️ Lightning"));
      console.log(`\n${tag} ${c.dim(`running ${fileCount} test file${fileCount === 1 ? "" : "s"}`)}\n`);
    },

    onFileDone(file) {
      const name = fileLabel(opts, file);
      const env = file.environment && file.environment !== "node" ? c.dim(` (${file.environment})`) : "";
      if (file.error) {
        console.log(`${c.red("✗")} ${c.red(name)} ${c.dim("(failed to load)")}${env}`);
        failures.push({ file: name, fileError: file.error });
        return;
      }

      const failed = file.results.filter((r) => r.state === "fail").length;
      const head = failed > 0 ? c.red("✗") : c.green("✓");
      console.log(`${head} ${c.dim(name)}${env}`);

      for (const r of file.results) {
        const leaf = r.fullName.split(" > ").join(c.dim(" › "));
        const suffix = r.state === "todo" ? c.dim(" [todo]") : r.state === "skip" ? c.dim(" [skipped]") : "";
        const dur = r.state === "pass" && r.durationMs >= 1 ? c.dim(` ${Math.round(r.durationMs)}ms`) : "";
        console.log(`  ${STATE_GLYPH[r.state]} ${leaf}${suffix}${dur}`);
        if (r.state === "fail") failures.push({ file: name, result: r });
      }
    },

    onFinished(_files, summary) {
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

      printSummary(summary);
    },
  };
}

export function printSummary(summary: RunSummary): void {
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

  if (summary.failedFiles > 0 || summary.failedTests > 0) console.log(c.bold(c.red("⚡️ test run failed")) + "\n");
  else if (summary.totalFiles === 0) console.log(c.yellow("⚡️ no test files found") + "\n");
  else console.log(c.bold(c.green("⚡️ all tests passed")) + "\n");
}
