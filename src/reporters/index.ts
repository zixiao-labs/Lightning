import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BuiltinReporter, FileResult, Reporter, ReporterConfig, ResolvedLightningConfig, RunSummary, TestResult } from "../types.ts";
import { createDefaultReporter, printSummary } from "./default.ts";

const BUILTIN = new Set<string>(["default", "verbose", "dot", "json", "junit", "tap", "github-actions"]);

export interface ReporterManager extends Reporter {
  onStart(fileCount: number, root: string): Promise<void>;
  onFileDone(file: FileResult): Promise<void>;
  onFinished(files: FileResult[], summary: RunSummary): Promise<void>;
}

export async function createReporterManager(config: ResolvedLightningConfig): Promise<ReporterManager> {
  const reporters = await Promise.all((config.reporters.length ? config.reporters : ["default"]).map((r) => resolveReporter(config, r)));
  return {
    async onStart(fileCount, root) {
      for (const reporter of reporters) await reporter.onStart?.(fileCount, root);
    },
    async onFileDone(file) {
      for (const reporter of reporters) await reporter.onFileDone?.(file);
    },
    async onFinished(files, summary) {
      for (const reporter of reporters) await reporter.onFinished?.(files, summary);
    },
  };
}

async function resolveReporter(config: ResolvedLightningConfig, reporter: ReporterConfig): Promise<Reporter> {
  if (typeof reporter !== "string") return reporter;
  if (BUILTIN.has(reporter)) return builtinReporter(config, reporter as BuiltinReporter);
  return loadCustomReporter(config, reporter);
}

async function loadCustomReporter(config: ResolvedLightningConfig, id: string): Promise<Reporter> {
  const specifier = id.startsWith(".") || id.startsWith("/")
    ? pathToFileURL(path.resolve(config.root, id)).href
    : id;
  const mod = await import(specifier);
  const candidate = mod.default ?? mod.reporter ?? mod;
  const reporter = typeof candidate === "function" ? candidate(config) : candidate;
  if (!reporter || typeof reporter !== "object") throw new Error(`Custom reporter '${id}' did not export a reporter object`);
  return reporter as Reporter;
}

function builtinReporter(config: ResolvedLightningConfig, id: BuiltinReporter): Reporter {
  if (id === "default" || id === "verbose") return createDefaultReporter({ root: config.root });
  if (id === "dot") return createDotReporter();
  if (id === "json") return createJsonReporter();
  if (id === "junit") return createJUnitReporter(config);
  if (id === "tap") return createTapReporter();
  return createGithubActionsReporter(config);
}

function createDotReporter(): Reporter {
  return {
    onStart() { process.stdout.write("\n"); },
    onFileDone(file) {
      if (file.error) { process.stdout.write("F"); return; }
      for (const test of file.results) process.stdout.write(test.state === "pass" ? "." : test.state === "fail" ? "F" : test.state === "skip" ? "S" : "T");
    },
    onFinished(_files, summary) { process.stdout.write("\n"); printSummary(summary); },
  };
}

function createJsonReporter(): Reporter {
  return {
    onFinished(files, summary) {
      const publicFiles = files.map(({ coverage: _coverage, ...file }) => file);
      console.log(JSON.stringify({ summary, files: publicFiles }, null, 2));
    },
  };
}

function createJUnitReporter(config: ResolvedLightningConfig): Reporter {
  return {
    async onFinished(files, summary) {
      const tests = files.flatMap((file) => file.results.map((result) => ({ file, result })));
      const cases = tests.map(({ file, result }) => junitCase(config, file, result)).join("\n");
      const loadErrors = files.filter((file) => file.error).map((file) => junitLoadError(config, file)).join("\n");
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${totalTests(summary)}" failures="${summary.failedTests + summary.failedFiles}" skipped="${summary.skippedTests + summary.todoTests}" time="${seconds(summary.durationMs)}">\n  <testsuite name="lightning" tests="${totalTests(summary)}" failures="${summary.failedTests + summary.failedFiles}" skipped="${summary.skippedTests + summary.todoTests}" time="${seconds(summary.durationMs)}">\n${cases}${loadErrors}\n  </testsuite>\n</testsuites>\n`;
      const dir = path.join(config.root, "test-results");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "junit.xml"), xml);
    },
  };
}

function createTapReporter(): Reporter {
  let index = 0;
  return {
    onStart() { console.log("TAP version 13"); },
    onFileDone(file) {
      if (file.error) {
        index++;
        console.log(`not ok ${index} - ${escapeTap(file.filepath)} load error`);
        console.log(`  ---\n  message: ${JSON.stringify(file.error.message)}\n  ...`);
        return;
      }
      for (const r of file.results) {
        index++;
        const status = r.state === "pass" ? "ok" : "not ok";
        const directive = r.state === "skip" ? " # SKIP" : r.state === "todo" ? " # TODO" : "";
        console.log(`${status} ${index} - ${escapeTap(r.fullName)}${directive}`);
        if (r.error) console.log(`  ---\n  message: ${JSON.stringify(r.error.message)}\n  ...`);
      }
    },
    onFinished() { console.log(`1..${index}`); },
  };
}

function createGithubActionsReporter(config: ResolvedLightningConfig): Reporter {
  return {
    onFileDone(file) {
      const filePath = path.relative(config.root, file.filepath).split(path.sep).join("/");
      if (file.error) console.log(`::error file=${escapeActions(filePath)}::${escapeActions(file.error.message)}`);
      for (const result of file.results) {
        if (result.state === "fail") console.log(`::error file=${escapeActions(filePath)},title=${escapeActions(result.fullName)}::${escapeActions(result.error?.message ?? "Test failed")}`);
      }
    },
  };
}

function junitCase(config: ResolvedLightningConfig, file: FileResult, result: TestResult): string {
  const classname = escapeXml(path.relative(config.root, file.filepath).split(path.sep).join("/"));
  const attrs = `classname="${classname}" name="${escapeXml(result.fullName)}" time="${seconds(result.durationMs)}"`;
  if (result.state === "fail") return `    <testcase ${attrs}>\n      <failure message="${escapeXml(result.error?.message ?? "Test failed")}">${escapeXml(result.error?.stack ?? result.error?.message ?? "")}</failure>\n    </testcase>`;
  if (result.state === "skip" || result.state === "todo") return `    <testcase ${attrs}>\n      <skipped />\n    </testcase>`;
  return `    <testcase ${attrs} />`;
}

function junitLoadError(config: ResolvedLightningConfig, file: FileResult): string {
  const classname = escapeXml(path.relative(config.root, file.filepath).split(path.sep).join("/"));
  return `    <testcase classname="${classname}" name="load error" time="${seconds(file.durationMs)}">\n      <failure message="${escapeXml(file.error?.message ?? "Load error")}">${escapeXml(file.error?.stack ?? file.error?.message ?? "")}</failure>\n    </testcase>`;
}

function totalTests(summary: RunSummary): number {
  return summary.passedTests + summary.failedTests + summary.skippedTests + summary.todoTests;
}

function seconds(ms: number): string { return (ms / 1000).toFixed(3); }
function escapeXml(value: string): string { return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[ch] ?? ch); }
function escapeTap(value: string): string { return value.replace(/[\r\n]/g, " "); }
function escapeActions(value: string): string { return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C"); }
