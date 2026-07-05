/**
 * Watch mode (ROADMAP Phase 3): "HMR for tests".
 *
 *   lightning            # defaults to watch (mirrors Vitest's bare `vitest`)
 *   lightning watch
 *
 * Design:
 * - A single long-lived Nasti server is kept warm for the whole session. The SSR
 *   runner caches evaluated modules by id, so unchanged modules aren't
 *   re-transformed across reruns. To force a test file to re-execute (a manual
 *   rerun, or after a dependency changed) we invalidate just its runner-cache
 *   entry and reload it — see `invalidateInRunner`. (We can't cache-bust with a
 *   `?t=` query: Nasti feeds the module id straight into rolldown's
 *   moduleRunnerTransform, which can't parse a query and emits empty code.)
 * - Reverse-dependency tracking: a `pre` transform plugin (`dep-graph.ts`)
 *   records importer→imported edges as modules flow through the SSR pipeline.
 *   On a file change we walk the graph upstream to find only the test files that
 *   transitively import the changed file, and rerun just those. This mirrors
 *   Vitest's `VitestWatcher.handleFileChanged`, but backed by our own graph
 *   because Nasti's SSR runner doesn't expose one.
 * - Transitive freshness: the runner skips a cached module's body on a hit, so an
 *   *intermediate* importer that wasn't invalidated would never re-import the
 *   changed leaf. Nasti's watcher only invalidates the single changed file, so we
 *   invalidate the rest of its importer closure ourselves — see
 *   `invalidateInRunner`.
 * - Interactive terminal (Vitest parity): `a` all / `r` rerun / `f` failed-only
 *   / `t` name filter / `p` filename filter / `u` update snapshots / `q` quit.
 *
 * Watch uses in-process (inline) execution rather than the worker pool: the warm
 * server's cache is what makes reruns fast, and workers can't share it across a
 * process boundary. Process-level isolation (Phase 1's `isolate`) is traded for
 * speed in the dev loop — per-file collector/vi state is still reset each file.
 */
import readline from "node:readline";
import path from "node:path";
import { glob } from "tinyglobby";
import c from "tinyrainbow";
import { createServer } from "@nasti-toolchain/nasti";
import type { FileResult, ResolvedLightningConfig } from "../types.ts";
import { readFile } from "node:fs/promises";
import { resolveLightningConfig, type ConfigOverrides } from "../config/resolve.ts";
import { runTestFile } from "../runtime/file-runner.ts";
import { createDefaultReporter } from "../reporters/default.ts";
import { createRunSummary } from "../reporters/summary.ts";
import type { Reporter } from "../types.ts";
import { DependencyGraph, createDepTrackerPlugin } from "./dep-graph.ts";
import { normalizePath } from "./path-utils.ts";

/** Debounce window for coalescing a burst of file changes into one rerun. */
const RERUN_DEBOUNCE_MS = 100;

const SHORTCUTS: ReadonlyArray<readonly [readonly string[], string]> = [
  [["a", "enter"], "rerun all tests"],
  [["r"], "rerun current pattern tests"],
  [["f"], "rerun only failed tests"],
  [["t"], "filter by a test name pattern"],
  [["p"], "filter by a filename"],
  [["u"], "update snapshots"],
  [["q"], "quit"],
];

function printShortcuts(): void {
  const lines = SHORTCUTS.map(([keys, desc]) => {
    const k = keys.map(c.bold).join(", ");
    return `${c.dim("  press ")}${c.reset(k)}${c.dim(` to ${desc}`)}`;
  }).join("\n");
  process.stdout.write(`\n${c.bold("  Watch Usage")}\n${lines}\n\n`);
}

function clearScreen(): void {
  process.stdout.write("\x1Bc");
}

async function discover(config: ResolvedLightningConfig, filters: string[]): Promise<string[]> {
  const matches = await glob(config.include, {
    cwd: config.root,
    ignore: config.exclude,
    absolute: true,
    dot: false,
  });
  const normalized = matches.map(normalizePath).sort();
  if (filters.length === 0) return normalized;
  const needles = filters.map(normalizePath);
  return normalized.filter((file) => needles.some((needle) => file.includes(needle)));
}

const ONLY_RE = /\b(?:test|it|describe)\s*\.\s*only\s*\(/;

async function detectGlobalOnly(files: string[]): Promise<boolean> {
  for (const file of files) {
    try {
      if (ONLY_RE.test(await readFile(file, "utf-8"))) return true;
    } catch {
      // best-effort; the real error surfaces on load
    }
  }
  return false;
}

function isTestFile(file: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function rel(root: string, file: string): string {
  return normalizePath(path.relative(root, file));
}

export interface WatchOptions {
  overrides: ConfigOverrides;
  fileFilters: string[];
  clearScreen?: boolean;
}

export async function watchTests(options: WatchOptions): Promise<void> {
  const { overrides, fileFilters } = options;
  const clearOnRerun = options.clearScreen ?? true;

  const config = await resolveLightningConfig(overrides);
  const graph = new DependencyGraph();
  // Prepend the dep tracker so it runs before the mock-hoist plugin and observes
  // the original ESM `import` statements.
  config.nasti.plugins = [createDepTrackerPlugin(graph, config.root), ...(config.nasti.plugins ?? [])];

  const server = await createServer(config.nasti);

  // Mutable watch state.
  let allTestFiles = new Set(await discover(config, fileFilters));
  let activeFileFilters = [...fileFilters];
  let namePattern: RegExp | undefined = config.testNamePattern;
  let updateSnapshots = config.updateSnapshots;
  /** One-shot snapshot update requested via the `u` shortcut; cleared per run. */
  let updateOnce = false;
  let failedFiles = new Set<string>();
  let running = false;
  let cancelRequested = false;
  let pending: { kind: "all" } | { kind: "failed" } | { kind: "files"; files: string[] } | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Changed files awaiting the next debounced rerun. */
  const pendingAffected = new Set<string>();
  /**
   * Absolute paths for which we're *synthesizing* a watcher `change` event to
   * invalidate the SSR runner cache (see `invalidateInRunner`). Our own change
   * listener skips these so a synthetic invalidation doesn't schedule a rerun.
   */
  const suppressedSynthetic = new Set<string>();

  function visibleTestFiles(): string[] {
    if (activeFileFilters.length === 0) return [...allTestFiles];
    const needles = activeFileFilters.map(normalizePath);
    return [...allTestFiles].filter((f) => needles.some((needle) => f.includes(needle)));
  }

  function effectiveConfig(): ResolvedLightningConfig {
    return {
      ...config,
      updateSnapshots: updateSnapshots || updateOnce,
      // testNamePattern is optional under exactOptionalPropertyTypes: omit the
      // key entirely rather than set it to `undefined`.
      ...(namePattern ? { testNamePattern: namePattern } : {}),
    };
  }

  async function runFiles(files: string[]): Promise<void> {
    if (files.length === 0) {
      process.stdout.write(`${c.dim("no test files to run\n")}`);
      return;
    }
    const cfg = effectiveConfig();
    updateOnce = false; // consumed into cfg above; a one-shot `u` applies to this run only
    const hasGlobalOnly = await detectGlobalOnly(files);
    // Force each test file to re-evaluate: invalidate its warm runner-cache entry
    // so the clean `ssrLoadModule(url)` below re-runs the module body (and thus
    // re-collects). We can't bust via a `?t=` query — Nasti feeds the module id
    // straight into rolldown's moduleRunnerTransform, which can't parse a query
    // and emits empty code. Intermediates were already invalidated upstream.
    invalidateInRunner(files);
    // Each rerun gets its own reporter so failure blocks and the duration
    // reflect only this rerun, not the whole session (the reporter accumulates
    // failures and anchors its clock at construction time).
    const reporter: Reporter = createDefaultReporter({ root: config.root });
    if (clearOnRerun) clearScreen();
    await reporter.onStart?.(files.length, config.root);

    const failed = new Set<string>();
    const fileResults: FileResult[] = [];
    for (const file of files) {
      if (cancelRequested) return;
      let result: FileResult;
      try {
        result = await runTestFile({ config: cfg, file, server, hasGlobalOnly });
      } catch (err) {
        result = {
          filepath: file,
          results: [],
          error: {
            message: err instanceof Error ? err.message : String(err),
            ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
          },
          durationMs: 0,
        };
      }
      const isFail = Boolean(result.error) || result.results.some((r) => r.state === "fail");
      if (isFail) failed.add(file);
      fileResults.push(result);
      await reporter.onFileDone?.(result);
    }
    failedFiles = failed;
    await reporter.onFinished?.(
      fileResults,
      createRunSummary(fileResults, fileResults.reduce((total, file) => total + file.durationMs, 0)),
    );
  }

  /** Execute a rerun request, guarding against re-entrancy. */
  async function execute(request: NonNullable<typeof pending>): Promise<void> {
    if (running) {
      cancelRequested = true;
      // Spin until the current run notices the cancel.
      while (running) await new Promise((r) => setTimeout(r, 10));
    }
    // Always start a fresh run with a clear cancel flag — otherwise a run that
    // was cancelled to make way for this one leaves the flag set, and this run's
    // first loop iteration would bail out immediately.
    cancelRequested = false;
    running = true;
    try {
      if (request.kind === "all") {
        await runFiles(visibleTestFiles());
      } else if (request.kind === "failed") {
        const targets = [...failedFiles];
        if (targets.length === 0) {
          process.stdout.write(`${c.green("No failed tests — nothing to rerun.\n")}`);
        } else {
          await runFiles(targets);
        }
      } else {
        await runFiles(request.files);
      }
    } finally {
      running = false;
    }
    if (pending) {
      const next = pending;
      pending = undefined;
      await execute(next);
    }
  }

  function schedule(request: NonNullable<typeof pending>): void {
    if (running) {
      pending = request;
      cancelRequested = true;
      return;
    }
    void execute(request);
  }

  /** Debounced: collect changed files, compute affected tests, rerun. */
  function scheduleAffectedRerun(changedFile: string): void {
    pendingAffected.add(normalizePath(path.resolve(changedFile)));
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      const changed = [...pendingAffected];
      pendingAffected.clear();
      handleChangedFiles(changed);
    }, RERUN_DEBOUNCE_MS);
  }

  /**
   * Evict `files` from Nasti's SSR module-runner cache so the next load
   * re-transforms and re-evaluates them. The runner exposes no public
   * invalidation hook, but its own watcher calls `runner.invalidateFile` on every
   * `change` event — so we re-emit `change` for each path. `invalidateFile` runs
   * synchronously (before the client-only, here-no-op HMR handler), so the entry
   * is gone by the time `emit` returns. Our own `change` listener skips
   * `suppressedSynthetic` paths so this never schedules a spurious rerun.
   *
   * Used both to re-execute the test files themselves (runFiles) and to refresh
   * the intermediate importers between a test and a changed leaf (handleChangedFiles).
   */
  function invalidateInRunner(files: Iterable<string>): void {
    const emitter = server.watcher as unknown as {
      emit(event: string, file: string): boolean;
    };
    for (const file of files) {
      const normalized = normalizePath(path.resolve(file));
      suppressedSynthetic.add(normalized);
      try {
        emitter.emit("change", normalized);
      } finally {
        suppressedSynthetic.delete(normalized);
      }
    }
  }

  function scheduleAffectedTargets(affected: Set<string>, intermediates: Set<string>): void {
    // Only rerun affected files that still exist in the known test set and pass the
    // active filename filter. Intermediates are invalidated regardless of visibility.
    let targets = [...affected].filter((f) => allTestFiles.has(f));
    if (activeFileFilters.length > 0) {
      const needles = activeFileFilters.map(normalizePath);
      targets = targets.filter((f) => needles.some((n) => f.includes(n)));
    }

    invalidateInRunner(intermediates);

    if (targets.length === 0) {
      // Nothing visible depended on the change — don't interrupt.
      return;
    }

    process.stdout.write(
      `${c.dim("rerun")} ${c.cyan(targets.map((f) => rel(config.root, f)).join(", "))}\n`,
    );
    schedule({ kind: "files", files: targets });
  }

  function handleChangedFiles(changed: string[]): void {
    const normalizedChanged = changed.map((file) => normalizePath(path.resolve(file)));
    // Newly created test files enter the known set.
    const newTests = new Set<string>();
    for (const file of normalizedChanged) {
      if (isTestFile(file) && !allTestFiles.has(file)) {
        allTestFiles.add(file);
        newTests.add(file);
      }
    }

    const changedSet = new Set(normalizedChanged);
    const affected = new Set<string>();
    const intermediates = new Set<string>();
    for (const file of normalizedChanged) {
      if (newTests.has(file)) {
        // A brand-new test file has no importer history yet — just run it.
        affected.add(file);
      } else {
        for (const hit of graph.getAffectedTestFiles(file, allTestFiles)) affected.add(hit);
        // Modules on a path between an affected test and this change must be
        // refreshed in the SSR runner, or the re-run test re-imports a cached
        // importer that never re-imports the changed leaf (→ stale). The affected
        // test files are re-evaluated by runFiles, and `file` itself was already
        // invalidated by Nasti's own watcher — so only the in-between modules
        // remain.
        for (const imp of graph.getTransitiveImporters(file)) {
          if (!changedSet.has(imp) && !allTestFiles.has(imp)) intermediates.add(imp);
        }
      }
      // Drop the changed file's outgoing edges; rebuilt when it re-transforms.
      graph.invalidate(file);
    }

    scheduleAffectedTargets(affected, intermediates);
  }

  // ── Watcher: reuse Nasti's chokidar watcher (already ignoring node_modules/.git) ─
  const watcher: { on: (e: string, cb: (f: string) => void) => void; close: () => void } =
    server.watcher;

  watcher.on("change", (file: string) => {
    const abs = normalizePath(path.resolve(file));
    if (suppressedSynthetic.has(abs)) return; // our own runner-invalidation emit
    scheduleAffectedRerun(abs);
  });
  watcher.on("add", (file: string) => {
    const abs = normalizePath(path.resolve(file));
    if (suppressedSynthetic.has(abs)) return;
    scheduleAffectedRerun(abs);
  });
  watcher.on("unlink", (file: string) => {
    const abs = normalizePath(path.resolve(file));
    if (suppressedSynthetic.has(abs)) return;

    const affected = new Set(graph.getAffectedTestFiles(abs, allTestFiles));
    const intermediates = new Set<string>();
    for (const imp of graph.getTransitiveImporters(abs)) {
      if (imp !== abs && !allTestFiles.has(imp)) intermediates.add(imp);
    }

    allTestFiles.delete(abs);
    failedFiles.delete(abs);
    graph.invalidate(abs);
    scheduleAffectedTargets(affected, intermediates);
  });

  // ── Interactive terminal ────────────────────────────────────────────────────
  let rl: readline.Interface | undefined;

  async function handleKey(str: string, key: { name?: string; ctrl?: boolean } | undefined): Promise<void> {
    // Ctrl-C / Esc: quit.
    if (str === "\x03" || str === "\x1B" || (key && key.ctrl && key.name === "c")) {
      await shutdown();
      return;
    }
    const name = key?.name;

    // If a run is in progress, any shortcut cancels it (except q which always quits).
    if (running && name !== "q") {
      cancelRequested = true;
      return;
    }

    if (name === "q") {
      await shutdown();
      return;
    }
    if (name === "h") {
      printShortcuts();
      return;
    }
    if (name === "u") {
      // One-shot: scheduling is async, so flip a transient flag that runFiles
      // consumes and clears, rather than mutating `updateSnapshots` (which the
      // run would read *after* a synchronous reset here — i.e. never see it).
      updateOnce = true;
      process.stdout.write(`${c.dim("updating snapshots on next rerun\n")}`);
      schedule({ kind: "all" });
      return;
    }
    if (name === "a" || name === "return") {
      // Rerun everything in scope, clearing any runtime `t` name filter (a CLI
      // `-t` is preserved via the resolved config default).
      namePattern = config.testNamePattern;
      schedule({ kind: "all" });
      return;
    }
    if (name === "r") {
      // Rerun the current visible set, keeping the active name/file filters.
      schedule({ kind: "all" });
      return;
    }
    if (name === "f") {
      schedule({ kind: "failed" });
      return;
    }
    if (name === "t") {
      await promptNamePattern();
      return;
    }
    if (name === "p") {
      await promptFilePattern();
      return;
    }
  }

  async function promptNamePattern(): Promise<void> {
    offKeys();
    const answer = await question(`${c.cyan("?")} ${c.bold("Input test name pattern (RegExp)")}: `);
    onKeys();
    const trimmed = answer.trim();
    try {
      namePattern = trimmed ? new RegExp(trimmed) : undefined;
    } catch {
      process.stdout.write(`${c.red(`Invalid RegExp: ${trimmed}\n`)}`);
      return;
    }
    schedule({ kind: "all" });
  }

  async function promptFilePattern(): Promise<void> {
    offKeys();
    const answer = await question(`${c.cyan("?")} ${c.bold("Input filename pattern")}: `);
    onKeys();
    activeFileFilters = answer.trim() ? [answer.trim()] : [...fileFilters];
    schedule({ kind: "all" });
  }

  function question(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      const q = readline.createInterface({ input: process.stdin, output: process.stdout });
      q.question(prompt, (ans) => {
        q.close();
        resolve(ans);
      });
    });
  }

  function onKeys(): void {
    offKeys();
    rl = readline.createInterface({ input: process.stdin, escapeCodeTimeout: 50 });
    readline.emitKeypressEvents(process.stdin, rl);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on("keypress", keypressHandler);
  }

  function offKeys(): void {
    rl?.close();
    rl = undefined;
    process.stdin.removeListener("keypress", keypressHandler);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  }

  async function keypressHandler(str: string, key: { name?: string; ctrl?: boolean } | undefined): Promise<void> {
    try {
      await handleKey(str, key);
    } catch (err) {
      process.stdout.write(`${c.red(`watch error: ${err instanceof Error ? err.message : String(err)}\n`)}`);
    }
  }

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    offKeys();
    if (debounceTimer) clearTimeout(debounceTimer);
    cancelRequested = true;
    // Give an in-flight run a moment to observe the cancel.
    while (running) await new Promise((r) => setTimeout(r, 10));
    try {
      await server.close();
    } catch {
      // best-effort
    }
    process.exitCode = 0;
    process.stdout.write(`${c.dim("\n⚡️ lightning watch stopped\n")}`);
    // Force exit: the (possibly piped) stdin handle and the dev server's sockets
    // can keep the event loop alive even after close()/pause(), so a bare return
    // would hang the process. The stop message above has already flushed.
    process.exit(0);
  }

  // ── Boot: initial full run, then arm keyboard shortcuts ──────────────────────
  onKeys();

  process.stdout.write(
    `\n${c.bold(c.yellow("⚡️ Lightning"))} ${c.dim(`watch — ${allTestFiles.size} test file${allTestFiles.size === 1 ? "" : "s"}\n\n`)}`,
  );

  await execute({ kind: "all" });

  printShortcuts();
}

export type { WatchOptions as WatchTestsOptions };
