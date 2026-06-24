/**
 * Resolve the effective Lightning config: defaults ← `lightning.config.*` ← CLI flags.
 *
 * A TS/JS config file is loaded through a throwaway Nasti server (`ssrLoadModule`),
 * reusing the same module-runner pipeline that runs the tests — so a `.ts` config with
 * top-level imports just works. The server is only spun up when a config file exists.
 */
import { existsSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "@nasti-toolchain/nasti";
import type {
  LightningConfig,
  ResolvedLightningConfig,
  TestOptions,
  TestPool,
} from "../types.ts";
import { createMockTransformPlugin } from "../mock/index.ts";

const CONFIG_NAMES = [
  "lightning.config.ts",
  "lightning.config.mts",
  "lightning.config.js",
  "lightning.config.mjs",
];

const DEFAULT_INCLUDE = ["**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"];
const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  "**/.nasti/**",
];

/** CLI flags that override file/default config. */
export interface ConfigOverrides {
  root?: string;
  config?: string;
  globals?: boolean;
  testNamePattern?: string;
  reporter?: string;
  silent?: boolean;
  pool?: TestPool;
  maxWorkers?: number;
  isolate?: boolean;
  retry?: number;
  repeats?: number;
  testTimeout?: number;
  update?: boolean;
}

function findConfigFile(root: string, explicit?: string): string | undefined {
  if (explicit) {
    const abs = path.isAbsolute(explicit)
      ? explicit
      : path.join(root, explicit);
    if (!existsSync(abs)) {
      throw new Error(
        `Config file not found: ${explicit} (resolved to ${abs})`,
      );
    }
    return abs;
  }
  for (const name of CONFIG_NAMES) {
    const abs = path.join(root, name);
    if (existsSync(abs)) return abs;
  }
  return undefined;
}

async function loadConfigFile(
  root: string,
  file: string,
): Promise<LightningConfig> {
  // `.mjs`/`.js` (ESM) can be imported directly; `.ts` needs the Nasti runner.
  if (/\.(mjs|js)$/.test(file)) {
    const mod = (await import(pathToFileURL(file).href)) as Record<
      string,
      unknown
    >;
    return (mod.default ?? mod.config ?? {}) as LightningConfig;
  }
  const server = await createServer({ root, logLevel: "silent" });
  try {
    const url = "/" + path.relative(root, file).split(path.sep).join("/");
    const mod = await server.ssrLoadModule(url);
    return (mod.default ?? mod.config ?? {}) as LightningConfig;
  } finally {
    await server.close();
  }
}

function toRegExp(pattern: string | RegExp | undefined): RegExp | undefined {
  if (pattern === undefined) return undefined;
  if (pattern instanceof RegExp) return pattern;
  return new RegExp(pattern);
}

function defaultMaxWorkers(): number {
  const count =
    typeof availableParallelism === "function"
      ? availableParallelism()
      : cpus().length;
  return Math.max(1, count - 1);
}

const VALID_POOLS: readonly TestPool[] = ["threads", "forks", "inline"];

function resolvePool(pool: TestPool | undefined): TestPool {
  const resolved = pool ?? "threads";
  if (!VALID_POOLS.includes(resolved)) {
    throw new Error(
      `Invalid pool: ${String(resolved)}. Expected one of ${VALID_POOLS.join(", ")}.`,
    );
  }
  return resolved;
}

export async function resolveLightningConfig(
  overrides: ConfigOverrides = {},
): Promise<ResolvedLightningConfig> {
  // Config discovery/loading uses the CLI root (or cwd); the file itself may then
  // declare its own `root` for running tests.
  const cwd = path.resolve(overrides.root ?? process.cwd());
  const configFile = findConfigFile(cwd, overrides.config);

  let fileConfig: LightningConfig = {};
  if (configFile) fileConfig = await loadConfigFile(cwd, configFile);

  const fileTest: TestOptions = fileConfig.test ?? {};
  const { test: _omitTest, root: _omitRoot, ...nasti } = fileConfig;

  // Priority: CLI override ← file config ← cwd.
  const root = path.resolve(overrides.root ?? fileConfig.root ?? process.cwd());

  const namePattern = toRegExp(
    overrides.testNamePattern ?? fileTest.testNamePattern,
  );
  const maxWorkers = Math.max(
    1,
    overrides.maxWorkers ??
      fileTest.poolOptions?.maxWorkers ??
      defaultMaxWorkers(),
  );
  const pool = resolvePool(overrides.pool ?? fileTest.pool);
  const nastiPlugins = [createMockTransformPlugin(), ...(nasti.plugins ?? [])];

  const resolved: ResolvedLightningConfig = {
    root,
    include: fileTest.include ?? DEFAULT_INCLUDE,
    exclude: fileTest.exclude ?? DEFAULT_EXCLUDE,
    globals: overrides.globals ?? fileTest.globals ?? false,
    testTimeout: overrides.testTimeout ?? fileTest.testTimeout ?? 5000,
    reporters: overrides.reporter
      ? [overrides.reporter]
      : (fileTest.reporters ?? ["default"]),
    pool,
    poolOptions: { maxWorkers },
    isolate: overrides.isolate ?? fileTest.isolate ?? true,
    retry: Math.max(0, overrides.retry ?? fileTest.retry ?? 0),
    repeats: Math.max(1, overrides.repeats ?? fileTest.repeats ?? 1),
    updateSnapshots: overrides.update ?? fileTest.update ?? false,
    snapshotDir: fileTest.snapshotDir ?? "__snapshots__",
    nasti: {
      ...nasti,
      plugins: nastiPlugins,
      root,
      logLevel: overrides.silent ? "silent" : (nasti.logLevel ?? "silent"),
    },
  };
  if (namePattern) resolved.testNamePattern = namePattern;
  return resolved;
}
