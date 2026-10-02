import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "import-meta-resolve";
import { importConfig } from "../config/load.ts";
import type { BuiltinReporter, FileResult, Reporter, ReporterConfig, ResolvedLightningConfig, RunSummary, TestResult } from "../types.ts";
import { createDefaultReporter, printSummary } from "./default.ts";

const BUILTIN = new Set<string>(["default", "verbose", "dot", "json", "junit", "tap", "github-actions"]);

export interface ReporterManager extends Reporter {
  onStart(fileCount: number, root: string): Promise<void>;
  onFileDone(file: FileResult): Promise<void>;
  onFinished(files: FileResult[], summary: RunSummary): Promise<void>;
}

export async function createReporterManager(config: ResolvedLightningConfig): Promise<ReporterManager> {
  const reporterConfigs = config.reporters.length ? config.reporters : ["default"];
  const errors: Error[] = [];
  const reporters = await Promise.all(reporterConfigs.map(async (r) => ({
    label: reporterLabel(r),
    reporter: await resolveReporter(config, r),
  })));
  return {
    async onStart(fileCount, root) {
      for (const { label, reporter } of reporters) await callReporter(label, "onStart", () => reporter.onStart?.(fileCount, root), errors);
    },
    async onFileDone(file) {
      for (const { label, reporter } of reporters) await callReporter(label, "onFileDone", () => reporter.onFileDone?.(file), errors);
    },
    async onFinished(files, summary) {
      for (const { label, reporter } of reporters) await callReporter(label, "onFinished", () => reporter.onFinished?.(files, summary), errors);
      if (errors.length) throw new AggregateError(errors, `Reporter hooks failed:\n${errors.map((error) => error.message).join("\n")}`);
    },
  };
}

async function callReporter(label: string, hook: keyof Reporter, callback: () => void | Promise<void>, errors: Error[]): Promise<void> {
  try {
    await callback();
  } catch (error) {
    errors.push(new Error(`Reporter '${label}' ${hook} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
  }
}

function reporterLabel(reporter: ReporterConfig): string {
  return typeof reporter === "string" ? reporter : reporter.constructor?.name || "custom";
}

async function resolveReporter(config: ResolvedLightningConfig, reporter: ReporterConfig): Promise<Reporter> {
  if (typeof reporter !== "string") return reporter;
  if (BUILTIN.has(reporter)) return builtinReporter(config, reporter as BuiltinReporter);
  return loadCustomReporter(config, reporter);
}

async function loadCustomReporter(config: ResolvedLightningConfig, id: string): Promise<Reporter> {
  const specifier = id.startsWith(".") || id.startsWith("/")
    ? pathToFileURL(path.resolve(config.root, id)).href
    : resolve(id, pathToFileURL(path.join(config.root, "package.json")).href);
  const mod = /\.[cm]?ts$/.test(id) ? await importConfig(path.resolve(config.root, id)) : await import(specifier);
  const candidate = mod.default ?? mod.reporter ?? mod;
  const reporter = typeof candidate === "function"
    ? candidate.prototype?.onFinished || candidate.prototype?.onFileDone || candidate.prototype?.onStart
      ? new candidate(config) : await candidate(config)
    : candidate;
  if (!reporter || typeof reporter !== "object") throw new Error(`Custom reporter '${id}' did not export a reporter object`);
  return reporter as Reporter;
}

function builtinReporter(config: ResolvedLightningConfig, id: BuiltinReporter): Reporter {
  if (id === "default" || id === "verbose") return createDefaultReporter({ root: config.root });
  if (id === "dot") return createDotReporter();
  if (id === "json") return createJsonReporter(config);
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

function reporterOutput(config: ResolvedLightningConfig, id: BuiltinReporter): string | undefined {
  const output = typeof config.outputFile === "string" ? config.outputFile : config.outputFile?.[id];
  return output ? path.resolve(config.root, output) : undefined;
}

function createJsonReporter(config: ResolvedLightningConfig): Reporter {
  return {
    async onFinished(files, summary) {
      const publicFiles = files.map(({ coverage: _coverage, istanbulCoverage: _istanbul, ...file }) => file);
      const seen = new WeakSet<object>();
      const json = JSON.stringify({ summary, files: publicFiles }, (_key, value: unknown) => {
        if (typeof value === "bigint") return `${value}n`;
        if (typeof value === "function") return `[Function ${value.name}]`;
        if (typeof value === "object" && value) {
          if (seen.has(value)) return "[Circular]";
          seen.add(value);
          if (value instanceof Error) return { message: value.message, stack: value.stack };
          if (value instanceof Map) return { type: "Map", entries: [...value] };
          if (value instanceof Set) return { type: "Set", values: [...value] };
        }
        return value;
      }, 2);
      const output = reporterOutput(config, "json");
      if (output) {
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, json + "\n");
      } else console.log(json);
    },
  };
}

function createJUnitReporter(config: ResolvedLightningConfig): Reporter {
  return {
    async onFinished(files, summary) {
      const tests = files.flatMap((file) => file.results.map((result) => ({ file, result })));
      const cases = tests.map(({ file, result }) => junitCase(config, file, result));
      const loadErrors = files.filter((file) => file.error).map((file) => junitLoadError(config, file));
      const entries = [...cases, ...loadErrors];
      const testCount = entries.length;
      const failureCount = tests.filter(({ result }) => result.state === "fail").length + loadErrors.length;
      const skippedCount = tests.filter(({ result }) => result.state === "skip" || result.state === "todo").length;
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${testCount}" failures="${failureCount}" skipped="${skippedCount}" time="${seconds(summary.durationMs)}">\n  <testsuite name="lightning" tests="${testCount}" failures="${failureCount}" skipped="${skippedCount}" time="${seconds(summary.durationMs)}">\n${entries.join("\n")}\n  </testsuite>\n</testsuites>\n`;
      const output = reporterOutput(config, "junit") ?? path.join(config.root, "test-results", "junit.xml");
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, xml);
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
        const status = r.state === "pass" || r.state === "skip" ? "ok" : "not ok";
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

function seconds(ms: number): string { return (ms / 1000).toFixed(3); }
function escapeXml(value: string): string { return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[ch] ?? ch); }
function escapeTap(value: string): string { return value.replace(/[\r\n]/g, " "); }
function escapeActions(value: string): string { return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C"); }
