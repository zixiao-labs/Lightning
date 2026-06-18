/**
 * Lightning CLI — mirrors Vitest's command/flag surface (via `cac`), with ⚡️ as the
 * only added branding. Phase 0 ships a single run; `watch` (bare `lightning`) lands
 * in Phase 3 and will become the default then, matching Vitest.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cac } from "cac";
import c from "tinyrainbow";
import { runTests } from "./node/orchestrator.ts";
import type { ConfigOverrides } from "./config/resolve.ts";

function readVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf-8")) as { version?: string };
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
}

function toOverrides(flags: CliFlags): ConfigOverrides {
  const o: ConfigOverrides = {};
  if (flags.root !== undefined) o.root = flags.root;
  if (flags.config !== undefined) o.config = flags.config;
  if (flags.testNamePattern !== undefined) o.testNamePattern = flags.testNamePattern;
  if (flags.globals !== undefined) o.globals = flags.globals;
  if (flags.reporter !== undefined) o.reporter = flags.reporter;
  if (flags.silent !== undefined) o.silent = flags.silent;
  return o;
}

async function run(filters: string[], flags: CliFlags): Promise<void> {
  try {
    const { summary } = await runTests(toOverrides(flags), filters);
    process.exitCode = summary.failedFiles > 0 || summary.failedTests > 0 ? 1 : 0;
  } catch (err) {
    console.error(c.red("⚡️ lightning crashed:"), err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  }
}

const cli = cac("lightning");

// Shared flag definitions (kept identical across the default + `run` commands).
function withFlags<T extends ReturnType<typeof cli.command>>(cmd: T): T {
  return cmd
    .option("-r, --root <path>", "Project root directory")
    .option("-c, --config <path>", "Path to a config file")
    .option("-t, --testNamePattern <pattern>", "Run only tests whose name matches the pattern")
    .option("--globals", "Inject test APIs (test/expect/...) onto globalThis")
    .option("--reporter <name>", "Reporter to use", { default: "default" })
    .option("--silent", "Silence Nasti server output") as T;
}

withFlags(cli.command("run [...filters]", "Run tests once and exit")).action(
  (filters: string[], flags: CliFlags) => run(filters, flags),
);

// Bare `lightning [...filters]`: run once for now (becomes watch in Phase 3).
withFlags(cli.command("[...filters]", "Run tests (watch mode arrives in Phase 3)")).action(
  (filters: string[], flags: CliFlags) => run(filters, flags),
);

cli.help((sections) => {
  sections.unshift({ body: c.bold(c.yellow("⚡️ Lightning")) + c.dim(" — a next-generation test framework") });
  return sections;
});
cli.version(readVersion());

cli.parse();
