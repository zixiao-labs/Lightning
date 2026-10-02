import inspector from "node:inspector";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "tinyglobby";
import v8ToIstanbul from "v8-to-istanbul";
import libCoverage from "istanbul-lib-coverage";
import type { CoverageMap } from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import type { CoverageThresholds, ResolvedLightningConfig, V8CoverageScript } from "../types.ts";

export interface PercentMetric { total: number; covered: number; pct: number }
export interface CoverageSummary {
  lines: PercentMetric;
  functions: PercentMetric;
  statements: PercentMetric;
  branches: PercentMetric;
}
export interface CoverageReportResult {
  files: Array<CoverageSummary & { file: string }>;
  summary: CoverageSummary;
  thresholdErrors: string[];
}
export interface CoverageSource {
  source: string;
  sourceMap?: V8CoverageScript["sourceMap"];
}
export interface CoverageReportOptions {
  /** Transform unexecuted files with the same compiler used by the runtime. */
  loadSource?: (file: string) => Promise<CoverageSource>;
}

export class CoverageSession {
  private session: inspector.Session | undefined;
  private maps = new Map<string, string>();

  constructor(private readonly root: string = process.cwd()) {}

  async start(): Promise<void> {
    const session = new inspector.Session();
    this.session = session;
    this.maps.clear();
    session.connect();
    session.on("Debugger.scriptParsed", ({ params }) => {
      if (params.sourceMapURL) this.maps.set(params.scriptId, params.sourceMapURL);
    });
    await post(session, "Debugger.enable");
    await post(session, "Profiler.enable");
    await post(session, "Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  }

  async stop(): Promise<V8CoverageScript[]> {
    const session = this.session;
    if (!session) return [];
    try {
      const { result } = await post<{ result: V8CoverageScript[] }>(session, "Profiler.takePreciseCoverage");
      const scripts = result.filter((script) => {
        const file = scriptFile(script.url);
        if (!file) return false;
        const relative = path.relative(this.root, file);
        return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      });
      for (const script of scripts) {
        const evaluated = await post<{ scriptSource: string }>(session, "Debugger.getScriptSource", { scriptId: script.scriptId });
        script.source = evaluated.scriptSource;
        const mapUrl = this.maps.get(script.scriptId);
        if (mapUrl) {
          try { script.sourceMap = await loadMap(mapUrl, script.url); }
          catch { /* Missing or invalid maps must not prevent coverage collection. */ }
        }
      }
      return scripts;
    } finally {
      await post(session, "Profiler.stopPreciseCoverage").catch(() => undefined);
      await post(session, "Profiler.disable").catch(() => undefined);
      await post(session, "Debugger.disable").catch(() => undefined);
      session.disconnect();
      this.session = undefined;
      this.maps.clear();
    }
  }
}

function post<T = unknown>(session: inspector.Session, method: string, params?: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    session.post(method, params ?? {}, (error, result) => error ? reject(error) : resolve(result as T));
  });
}

async function loadMap(url: string, scriptUrl: string): Promise<NonNullable<V8CoverageScript["sourceMap"]>> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    const metadata = url.slice(0, comma);
    const payload = url.slice(comma + 1);
    return JSON.parse(metadata.includes(";base64") ? Buffer.from(payload, "base64").toString("utf8") : decodeURIComponent(payload));
  }
  const file = scriptFile(scriptUrl);
  if (!file) throw new Error(`Cannot resolve coverage source map for ${scriptUrl}`);
  const mapFile = url.startsWith("file:") ? fileURLToPath(url) : path.resolve(path.dirname(file), url);
  return JSON.parse(await readFile(mapFile, "utf8"));
}

function scriptFile(url: string): string | undefined {
  try {
    if (url.startsWith("file:")) return fileURLToPath(new URL(url));
    const clean = url.split(/[?#]/)[0]!;
    if (clean.startsWith("/@fs/")) return clean.slice(4);
    return path.isAbsolute(clean) ? clean : undefined;
  } catch { return undefined; }
}

const metrics = ["lines", "functions", "statements", "branches"] as const;

export function checkThresholds(summary: CoverageSummary, thresholds?: CoverageThresholds): string[] {
  return metrics.flatMap((key) => {
    const expected = thresholds?.[key];
    return expected !== undefined && summary[key].pct < expected
      ? [`Coverage for ${key} (${summary[key].pct}%) does not meet threshold (${expected}%)`]
      : [];
  });
}

/** Convert each evaluated script independently, then merge Istanbul counters by source location. */
export async function createCoverageReport(
  config: ResolvedLightningConfig,
  scripts: V8CoverageScript[],
  options: CoverageReportOptions = {},
): Promise<CoverageReportResult> {
  const included = await glob(config.coverage.include, {
    cwd: config.root, ignore: config.coverage.exclude, absolute: true, dot: false,
  });
  const allowed = new Set(included.map((file) => path.resolve(file)));
  const coverageMap = libCoverage.createCoverageMap({});
  const seen = new Set<string>();
  const convert = async (file: string, input: CoverageSource, functions: V8CoverageScript["functions"]) => {
    const converter = v8ToIstanbul(file, 0, {
      source: input.source,
      ...(input.sourceMap ? { sourceMap: { sourcemap: input.sourceMap } } : {}),
    });
    await converter.load();
    converter.applyCoverage(functions);
    for (const [original, data] of Object.entries(converter.toIstanbul())) {
      if (!allowed.has(path.resolve(original))) continue;
      coverageMap.merge({ [original]: data });
      seen.add(path.resolve(original));
    }
  };
  for (const script of scripts) {
    const file = scriptFile(script.url);
    if (!file) continue;
    const relative = path.relative(config.root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (script.source === undefined) {
      if (allowed.has(file)) throw new Error(`Missing evaluated JavaScript source for coverage: ${file}`);
      continue;
    }
    if (/\.[cm]?tsx?$/.test(file) && !script.sourceMap) {
      if (allowed.has(file)) throw new Error(`Missing source map for TypeScript coverage: ${file}`);
      continue;
    }
    await convert(file, { source: script.source, ...(script.sourceMap ? { sourceMap: script.sourceMap } : {}) }, script.functions);
  }
  for (const file of [...allowed].sort()) {
    if (seen.has(file)) continue;
    let input: CoverageSource;
    if (options.loadSource) input = await options.loadSource(file);
    else {
      if (/\.[cm]?tsx?$/.test(file)) throw new Error(`Unexecuted TypeScript coverage requires loadSource: ${file}`);
      input = { source: await readFile(file, "utf8") };
    }
    if (/\.[cm]?tsx?$/.test(file) && !input.sourceMap) throw new Error(`Missing source map for TypeScript coverage: ${file}`);
    await convert(file, input, [{
      functionName: "(empty-report)", isBlockCoverage: true,
      ranges: [{ startOffset: 0, endOffset: input.source.length, count: 0 }],
    }]);
  }
  return writeCoverageReport(config, coverageMap);
}

/** Shared reporting boundary for both V8 conversion and Istanbul instrumentation. */
export function writeCoverageReport(config: ResolvedLightningConfig, coverageMap: CoverageMap): CoverageReportResult {
  const summary = coverageMap.getCoverageSummary().data;
  const files = coverageMap.files().sort().map((file) => ({
    file, ...coverageMap.fileCoverageFor(file).toSummary().data,
  }));
  const result: CoverageReportResult = { files, summary, thresholdErrors: checkThresholds(summary, config.coverage.thresholds) };
  const context = libReport.createContext({
    dir: path.resolve(config.root, config.coverage.reportsDirectory), coverageMap,
  });
  for (const reporter of config.coverage.reporter) reports.create(reporter).execute(context);
  for (const error of result.thresholdErrors) console.error(error);
  return result;
}
