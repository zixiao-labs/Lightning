/**
 * Lightning CLI — mirrors Vitest's command/flag surface (via `cac`), with ⚡️ as the
 * only added branding.
 *
 *   lightning            # watch in a TTY, run-once in CI/non-TTY (like bare `vitest`)
 *   lightning watch      # always watch
 *   lightning run        # always run once and exit
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cac } from "cac";
import c from "tinyrainbow";
import { runTests } from "./node/orchestrator.ts";
import { watchTests } from "./node/watch.ts";
import type { ConfigOverrides } from "./config/resolve.ts";
import type { TestPool } from "./types.ts";

function readVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface CliFlags {
  root?: string;
  config?: string;
  testNamePattern?: string;
  globals?: boolean;
  reporter?: string;
  silent?: boolean;
  pool?: TestPool;
  maxWorkers?: string | number;
  isolate?: boolean;
  retry?: string | number;
  repeats?: string | number;
  testTimeout?: string | number;
  update?: boolean;
  watch?: boolean;
  clearScreen?: boolean;
}

function toNumber(
  value: string | number | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  // maxWorkers/retry/repeats/testTimeout are all non-negative integer counts.
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`Invalid ${name}: ${value} (expected a non-negative integer)`);
  return parsed;
}

function toOverrides(flags: CliFlags): ConfigOverrides {
  const o: ConfigOverrides = {};
  if (flags.root !== undefined) o.root = flags.root;
  if (flags.config !== undefined) o.config = flags.config;
  if (flags.testNamePattern !== undefined)
    o.testNamePattern = flags.testNamePattern;
  if (flags.globals !== undefined) o.globals = flags.globals;
  // cac always populates `reporter` with its `{ default: "default" }` value, so an
  // unmodified flag is indistinguishable from `--reporter default`. Treat the default
  // as "not provided" to keep priority order (cac default ← config file ← explicit flag).
  if (flags.reporter !== undefined && flags.reporter !== "default")
    o.reporter = flags.reporter;
  if (flags.silent !== undefined) o.silent = flags.silent;
  if (flags.pool !== undefined) o.pool = flags.pool;
  const maxWorkers = toNumber(flags.maxWorkers, "--maxWorkers");
  if (maxWorkers !== undefined) o.maxWorkers = maxWorkers;
  if (flags.isolate !== undefined) o.isolate = flags.isolate;
  const retry = toNumber(flags.retry, "--retry");
  if (retry !== undefined) o.retry = retry;
  const repeats = toNumber(flags.repeats, "--repeats");
  if (repeats !== undefined) o.repeats = repeats;
  const testTimeout = toNumber(flags.testTimeout, "--test-timeout");
  if (testTimeout !== undefined) o.testTimeout = testTimeout;
  if (flags.update !== undefined) o.update = flags.update;
  return o;
}

async function run(filters: string[], flags: CliFlags): Promise<void> {
  try {
    const { summary } = await runTests(toOverrides(flags), filters);
    process.exitCode =
      summary.failedFiles > 0 || summary.failedTests > 0 ? 1 : 0;
  } catch (err) {
    console.error(
      c.red("⚡️ lightning crashed:"),
      err instanceof Error ? err.stack : err,
    );
    process.exitCode = 1;
  }
}

async function watch(filters: string[], flags: CliFlags): Promise<void> {
  try {
    await watchTests({
      overrides: toOverrides(flags),
      fileFilters: filters,
      // cac defaults clearScreen to true and sets it false on --no-clearScreen.
      // The spread keeps the key off entirely when somehow unset (exactOptional).
      ...(flags.clearScreen !== undefined ? { clearScreen: flags.clearScreen } : {}),
    });
  } catch (err) {
    console.error(
      c.red("⚡️ lightning watch crashed:"),
      err instanceof Error ? err.stack : err,
    );
    process.exitCode = 1;
  }
}

/**
 * Bare `lightning` watches in an interactive terminal but runs once in CI /
 * non-TTY (mirrors bare `vitest`). `--watch` / `--no-watch` overrides the
 * heuristic.
 */
function shouldWatch(flags: CliFlags): boolean {
  if (flags.watch !== undefined) return flags.watch;
  return Boolean(process.stdin.isTTY);
}

const cli = cac("lightning");

// Shared flag definitions (kept identical across the default + `run` commands).
function withFlags<T extends ReturnType<typeof cli.command>>(cmd: T): T {
  return cmd
    .option("-r, --root <path>", "Project root directory")
    .option("-c, --config <path>", "Path to a config file")
    .option(
      "-t, --testNamePattern <pattern>",
      "Run only tests whose name matches the pattern",
    )
    .option("--globals", "Inject test APIs (test/expect/...) onto globalThis")
    .option("--reporter <name>", "Reporter to use", { default: "default" })
    .option("--pool <pool>", "Execution pool: threads, forks, or inline")
    .option(
      "--maxWorkers <number>",
      "Maximum number of test files running at once",
    )
    .option("--isolate", "Run each test file in an isolated worker")
    .option("--no-isolate", "Disable file-level worker isolation")
    .option("--retry <number>", "Retry failing tests this many times")
    .option("--repeats <number>", "Repeat each test this many times")
    .option("--test-timeout <ms>", "Default per-test timeout in milliseconds")
    .option("-u, --update", "Update snapshots")
    .option("-w, --watch", "Rerun tests on file change (default in a TTY; use --no-watch to disable)")
    .option("--no-clearScreen", "Keep the terminal scrollback between reruns")
    .option("--silent", "Silence Nasti server output") as T;
}

withFlags(cli.command("run [...filters]", "Run tests once and exit")).action(
  (filters: string[], flags: CliFlags) => run(filters, flags),
);

withFlags(
  cli.command("watch [...filters]", "Rerun affected tests on file change"),
).action((filters: string[], flags: CliFlags) => watch(filters, flags));

// Bare `lightning [...filters]`: watch in a TTY, run once otherwise.
withFlags(
  cli.command("[...filters]", "Run tests (watch in a TTY, run once in CI)"),
).action((filters: string[], flags: CliFlags) =>
  shouldWatch(flags) ? watch(filters, flags) : run(filters, flags),
);

cli.help((sections) => {
  sections.unshift({
    body:
      c.bold(c.yellow("⚡️ Lightning")) +
      c.dim(" — a next-generation test framework"),
  });
  return sections;
});
cli.version(readVersion());

cli.parse();
