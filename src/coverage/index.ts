import inspector from "node:inspector";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "tinyglobby";
import c from "tinyrainbow";
import type { CoverageThresholds, ResolvedLightningConfig, V8CoverageScript } from "../types.ts";

type V8Script = V8CoverageScript;
interface FileCoverage {
  file: string;
  lines: { total: number; covered: number; details: Array<{ line: number; hits: number; text: string }> };
  functions: { total: number; covered: number };
  // V8 coverage here does not expose Istanbul statement/branch maps, so these
  // metrics are line-based approximations derived from covered V8 ranges.
  statements: { total: number; covered: number };
  branches: { total: number; covered: number };
}
const APPROXIMATE_COVERAGE_NOTE =
  "Branch and statement coverage are line-based approximations from V8 coverage ranges.";
export interface PercentMetric { total: number; covered: number; pct: number }
export interface CoverageSummary {
  lines: PercentMetric;
  functions: PercentMetric;
  statements: PercentMetric;
  branches: PercentMetric;
}
export interface CoverageReportResult {
  files: FileCoverage[];
  summary: CoverageSummary;
  thresholdErrors: string[];
}

export class CoverageSession {
  private session: inspector.Session | undefined;

  async start(): Promise<void> {
    this.session = new inspector.Session();
    this.session.connect();
    await post(this.session, "Profiler.enable");
    await post(this.session, "Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  }

  async stop(): Promise<V8Script[]> {
    const session = this.session;
    if (!session) return [];
    try {
      const result = await post<{ result: V8Script[] }>(session, "Profiler.takePreciseCoverage");
      await post(session, "Profiler.stopPreciseCoverage").catch(() => undefined);
      await post(session, "Profiler.disable").catch(() => undefined);
      return result.result;
    } finally {
      session.disconnect();
      this.session = undefined;
    }
  }
}

function post<T = unknown>(session: inspector.Session, method: string, params?: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    session.post(method, params ?? {}, (error, result) => error ? reject(error) : resolve(result as T));
  });
}

function pct(covered: number, total: number): PercentMetric {
  return { total, covered, pct: total === 0 ? 100 : Math.round((covered / total) * 10000) / 100 };
}

function scriptFile(url: string): string | undefined {
  if (!url || url.startsWith("node:") || url.startsWith("internal/")) return undefined;
  const clean = url.split("?")[0]?.split("#")[0] ?? url;
  try { if (clean.startsWith("file://")) return fileURLToPath(clean); } catch { return undefined; }
  if (clean.startsWith("/@fs/")) return clean.slice(4);
  return path.isAbsolute(clean) && existsSync(clean) ? clean : undefined;
}

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function starts(source: string): number[] {
  const out = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

function lineFor(lineStarts: number[], offset: number): number {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((lineStarts[mid] ?? 0) <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(1, hi + 1);
}

async function convert(file: string, scripts: V8Script[]): Promise<FileCoverage> {
  const source = await readFile(file, "utf-8").catch(() => "");
  const lines = source.split(/\r?\n/);
  const lineStarts = starts(source);
  const hits = new Map<number, number>();
  let totalFunctions = 0;
  let coveredFunctions = 0;

  for (const script of scripts) {
    for (const fn of script.functions) {
      totalFunctions++;
      if (fn.ranges.some((r) => r.count > 0)) coveredFunctions++;
      for (const range of fn.ranges) {
        if (range.count <= 0) continue;
        const startLine = lineFor(lineStarts, range.startOffset);
        const endLine = lineFor(lineStarts, Math.max(range.startOffset, range.endOffset - 1));
        for (let line = startLine; line <= endLine; line++) {
          const text = lines[line - 1] ?? "";
          if (text.trim()) hits.set(line, Math.max(hits.get(line) ?? 0, range.count));
        }
      }
    }
  }

  const details = lines
    .map((text, index) => ({ line: index + 1, hits: hits.get(index + 1) ?? 0, text }))
    .filter((line) => line.text.trim().length > 0);
  const total = details.length;
  const covered = details.filter((line) => line.hits > 0).length;
  return {
    file,
    lines: { total, covered, details },
    functions: { total: totalFunctions, covered: coveredFunctions },
    statements: { total, covered },
    branches: { total, covered },
  };
}

function mergeScripts(root: string, scripts: V8Script[]): Map<string, V8Script[]> {
  const map = new Map<string, V8Script[]>();
  for (const script of scripts) {
    const file = scriptFile(script.url);
    if (!file || !inside(root, file)) continue;
    const list = map.get(file) ?? [];
    list.push(script);
    map.set(file, list);
  }
  return map;
}

async function includeFiles(config: ResolvedLightningConfig): Promise<string[]> {
  const files = await glob(config.coverage.include, {
    cwd: config.root,
    ignore: config.coverage.exclude,
    absolute: true,
    dot: false,
  });
  return files.map((f) => f.split(path.sep).join("/")).sort();
}

function summarize(files: FileCoverage[]): CoverageSummary {
  const sum = (key: "lines" | "functions" | "statements" | "branches") => {
    const total = files.reduce((n, f) => n + f[key].total, 0);
    const covered = files.reduce((n, f) => n + f[key].covered, 0);
    return pct(covered, total);
  };
  return { lines: sum("lines"), functions: sum("functions"), statements: sum("statements"), branches: sum("branches") };
}

function coverageMetricLabel(key: "lines" | "functions" | "statements" | "branches"): string {
  return key === "statements" || key === "branches"
    ? `${key} (line-based approximation)`
    : key;
}

function thresholdErrors(summary: CoverageSummary, thresholds?: CoverageThresholds): string[] {
  if (!thresholds) return [];
  const out: string[] = [];
  for (const key of ["lines", "functions", "statements", "branches"] as const) {
    const expected = thresholds[key];
    if (expected !== undefined && summary[key].pct < expected) {
      out.push(`Coverage for ${coverageMetricLabel(key)} (${summary[key].pct}%) does not meet threshold (${expected}%)`);
    }
  }
  return out;
}

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function table(config: ResolvedLightningConfig, files: FileCoverage[], summary: CoverageSummary): string {
  const rows = [["File", "% Lines", "% Funcs", "% Branch*", "% Stmts*"]];
  for (const f of files) rows.push([rel(config.root, f.file), String(pct(f.lines.covered, f.lines.total).pct), String(pct(f.functions.covered, f.functions.total).pct), String(pct(f.branches.covered, f.branches.total).pct), String(pct(f.statements.covered, f.statements.total).pct)]);
  rows.push(["All files", String(summary.lines.pct), String(summary.functions.pct), String(summary.branches.pct), String(summary.statements.pct)]);
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]?.length ?? 0)));
  const rendered = rows.map((r, index) => r.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join(" | ") + (index === 0 ? `\n${widths.map((w) => "-".repeat(w)).join("-|-")}` : "")).join("\n");
  return `${rendered}\n* ${APPROXIMATE_COVERAGE_NOTE}`;
}

async function writeJson(dir: string, result: CoverageReportResult): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "coverage-final.json"), JSON.stringify(result, null, 2));
}

async function writeHtml(config: ResolvedLightningConfig, dir: string, result: CoverageReportResult): Promise<void> {
  await mkdir(dir, { recursive: true });
  const rows = result.files.map((f) => `<tr><td>${escapeHtml(rel(config.root, f.file))}</td><td>${pct(f.lines.covered, f.lines.total).pct}%</td><td>${pct(f.functions.covered, f.functions.total).pct}%</td><td>${pct(f.branches.covered, f.branches.total).pct}%</td><td>${pct(f.statements.covered, f.statements.total).pct}%</td></tr>`).join("\n");
  await writeFile(path.join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><title>Lightning Coverage</title><style>body{font-family:ui-sans-serif,system-ui;margin:2rem}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:.35rem .6rem}th{background:#f6f8fa}</style><h1>Lightning Coverage</h1><p>Lines: ${result.summary.lines.pct}%</p><table><thead><tr><th>File</th><th>Lines</th><th>Functions</th><th>Branches*</th><th>Statements*</th></tr></thead><tbody>${rows}</tbody></table><p><small>* ${escapeHtml(APPROXIMATE_COVERAGE_NOTE)}</small></p>`);
}

async function writeLcov(config: ResolvedLightningConfig, dir: string, files: FileCoverage[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const body = files.map((f) => [
    "TN:",
    `SF:${f.file}`,
    ...f.lines.details.map((line) => `DA:${line.line},${line.hits}`),
    `LF:${f.lines.total}`,
    `LH:${f.lines.covered}`,
    "end_of_record",
  ].join("\n")).join("\n");
  await writeFile(path.join(dir, "lcov.info"), body || `TN:\nSF:${config.root}\nend_of_record\n`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch] ?? ch);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function tryWriteReport(name: string, dir: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    console.warn(c.yellow(`Warning: failed to write ${name} coverage report to ${dir}: ${errorMessage(error)}`));
  }
}

export async function createCoverageReport(config: ResolvedLightningConfig, scripts: V8Script[]): Promise<CoverageReportResult> {
  const byFile = mergeScripts(config.root, scripts);
  const included = await includeFiles(config);
  const files: FileCoverage[] = [];
  for (const file of included) files.push(await convert(file, byFile.get(file) ?? []));
  const summary = summarize(files);
  const result = { files, summary, thresholdErrors: thresholdErrors(summary, config.coverage.thresholds) };
  const outDir = path.resolve(config.root, config.coverage.reportsDirectory);
  if (config.coverage.reporter.includes("text")) console.log(`\n${c.bold("Coverage report")}\n${table(config, files, summary)}\n`);
  if (config.coverage.reporter.includes("json")) await tryWriteReport("json", outDir, () => writeJson(outDir, result));
  if (config.coverage.reporter.includes("html")) await tryWriteReport("html", outDir, () => writeHtml(config, outDir, result));
  if (config.coverage.reporter.includes("lcov")) await tryWriteReport("lcov", outDir, () => writeLcov(config, outDir, files));
  for (const error of result.thresholdErrors) console.error(c.red(error));
  return result;
}
