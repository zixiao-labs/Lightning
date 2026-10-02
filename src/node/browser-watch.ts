/**
 * Browser watch: a warm Nasti client server tracks imports, while every run
 * launches a fresh browser pool. No SSR evaluation or runner cache is involved.
 */
import path from "node:path";
import readline from "node:readline";
import { glob } from "tinyglobby";
import { createServer } from "@nasti-toolchain/nasti";
import type { ResolvedLightningConfig } from "../types.ts";
import { BrowserTestHub } from "../browser/middleware.ts";
import { createBrowserApiPlugin } from "../browser/plugin.ts";
import { runFilesInBrowser } from "../browser/pool.ts";
import { reportCoverage } from "./test-server.ts";
import { createIstanbulCoverageReport } from "../coverage/istanbul.ts";
import { createDefaultReporter } from "../reporters/default.ts";
import { createRunSummary } from "../reporters/summary.ts";
import { DependencyGraph, createDepTrackerPlugin } from "./dep-graph.ts";
import { normalizePath } from "./path-utils.ts";
import { detectGlobalOnly } from "./only.ts";

export interface BrowserWatchOptions {
  config: ResolvedLightningConfig;
  fileFilters: string[];
  clearScreen?: boolean;
}

export async function watchBrowserTests(options: BrowserWatchOptions): Promise<void> {
  const { config, fileFilters } = options;
  if (config.coverage.enabled && config.coverage.provider === "v8" && config.browser.browsers.some((name) => name !== "chromium")) {
    throw new Error("Browser JavaScript coverage requires Chromium; Firefox and WebKit coverage are not supported.");
  }
  const graph = new DependencyGraph();
  const server = await createServer({
    ...config.nasti,
    plugins: [createDepTrackerPlugin(graph, config.root), createBrowserApiPlugin(), ...(config.nasti.plugins ?? [])],
  });
  const hub = new BrowserTestHub();
  server.middlewares.use("/__lightning__", hub.handler);
  const abort = new AbortController();
  let stopped = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let allFiles = new Set<string>();
  const pendingChanges = new Set<string>();
  let pendingAll = true;
  let updateOnce = false;
  let wake!: () => void;
  const stoppedPromise = new Promise<void>((resolve) => { wake = resolve; });

  async function discover(): Promise<Set<string>> {
    const files = await glob(config.include, {
      cwd: config.root, ignore: config.exclude, absolute: true, followSymbolicLinks: false,
    });
    const needles = fileFilters.map(normalizePath);
    return new Set(files.map(normalizePath).filter((file) => !/\.(?:test|spec)-d\.[cm]?ts$/.test(file)).sort().filter((file) =>
      needles.length === 0 || needles.some((needle) => file.includes(needle))));
  }

  async function execute(): Promise<void> {
    const changed = [...pendingChanges];
    pendingChanges.clear();
    const full = pendingAll;
    pendingAll = false;
    const previous = allFiles;
    allFiles = await discover();
    const affected = new Set<string>();
    for (const file of changed) {
      for (const test of graph.getAffectedTestFiles(file, previous)) affected.add(test);
      for (const test of graph.getAffectedTestFiles(file, allFiles)) affected.add(test);
    }
    const files = full ? [...allFiles] : [...affected].filter((file) => allFiles.has(file)).sort();
    if (stopped || files.length === 0) return;
    // Watcher events may coalesce rapid writes after Nasti has already cached
    // an intermediate transform. Invalidate at the run boundary, not just at
    // notification time, so new pages always request the final source.
    const clientGraph = server.environments.client!.moduleGraph;
    if (full) clientGraph.invalidateAll();
    else for (const file of changed) {
      for (const mod of clientGraph.getModulesByFile(file) ?? []) {
        clientGraph.invalidateModuleAndImporters(mod);
      }
    }
    if (options.clearScreen && process.stdout.isTTY) process.stdout.write("\x1Bc");
    const reporter = createDefaultReporter({ root: config.root });
    const start = performance.now();
    await reporter.onStart?.(files.length * config.browser.browsers.length, config.root);
    const runConfig = { ...config, updateSnapshots: config.updateSnapshots || updateOnce };
    updateOnce = false;
    const results = await runFilesInBrowser({
      config: runConfig, files,
      hasGlobalOnly: await detectGlobalOnly([...allFiles]),
      server, hub, signal: abort.signal,
      onFileDone: (result) => reporter.onFileDone?.(result),
    });
    if (stopped) return;
    const summary = createRunSummary(results, performance.now() - start);
    process.exitCode = summary.failedFiles || summary.failedTests ? 1 : 0;
    if (config.coverage.enabled) {
      const report = config.coverage.provider === "istanbul"
        ? await createIstanbulCoverageReport(config, results.map((result) => result.istanbulCoverage ?? {}))
        : await reportCoverage(config, results.flatMap((result) => result.coverage ?? []));
      if (report.thresholdErrors.length) process.exitCode = 1;
    }
    await reporter.onFinished?.(results, summary);
    process.stdout.write("\nBrowser watch ready — a/r/Enter rerun, u update snapshots, q quit\n");
  }

  function drain(): void {
    if (stopped || running || (!pendingAll && pendingChanges.size === 0)) return;
    running = execute().catch((error) => {
      if (!stopped) console.error("[lightning] browser watch run failed:", error);
    }).finally(() => {
      running = undefined;
      // Changes arriving during a run stay queued, even when their debounce
      // timer has already fired. Never run two pools concurrently.
      if (!stopped && !timer) drain();
    });
  }

  function changed(file: string): void {
    pendingChanges.add(normalizePath(path.resolve(config.root, file)));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; drain(); }, 100);
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    abort.abort();
    wake();
  }

  function keypress(str: string, key?: { name?: string; ctrl?: boolean }): void {
    if (str === "q" || (key?.ctrl && key.name === "c")) { stop(); return; }
    if (str === "u") updateOnce = true;
    if (["a", "r", "u"].includes(str) || key?.name === "return") {
      pendingAll = true;
      drain();
    }
  }

  const wasRaw = process.stdin.isRaw;
  const wasFlowing = process.stdin.readableFlowing === true;
  try {
    await server.listen(0);
    server.watcher.on("change", changed);
    server.watcher.on("add", changed);
    server.watcher.on("unlink", changed);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.on("keypress", keypress);
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }
    drain();
    await stoppedPromise;
  } finally {
    stopped = true;
    abort.abort();
    if (timer) clearTimeout(timer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.stdin.removeListener("keypress", keypress);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw ?? false);
      if (!wasFlowing) process.stdin.pause();
    }
    await running;
    await server.close();
    process.stdout.write("\n⚡️ Lightning browser watch stopped\n");
  }
}
