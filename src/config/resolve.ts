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
  CoverageOptions,
  CoverageProvider,
  CoverageThresholds,
  CoverageReporter,
  LightningConfig,
  ProjectConfig,
  ReporterConfig,
  ResolvedLightningConfig,
  ShardOptions,
  TestEnvironment,
  TestOptions,
  TestPool,
} from "../types.ts";
import { createMockTransformPlugin } from "../mock/index.ts";
import type {
  BrowserName,
  BrowserOptions,
  BrowserProviderName,
} from "../types.ts";

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
const DEFAULT_COVERAGE_EXCLUDE = [
  ...DEFAULT_EXCLUDE,
  "**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
  "**/__tests__/**",
  "**/__fixtures__/**",
  "**/coverage/**",
];
const DEFAULT_COVERAGE_INCLUDE = ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"];

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
  environment?: TestEnvironment;
  /** Enable browser mode (`--browser`). */
  browser?: boolean;
  /** Browser matrix override (`--browser-name chromium,firefox`). */
  browserName?: BrowserName[];
  /** Launch browsers with a visible window (`--headed`). */
  headed?: boolean;
  coverage?: boolean;
  coverageProvider?: CoverageProvider;
  coverageReporter?: CoverageReporter[];
  coverageReportsDirectory?: string;
  shard?: ShardOptions;
  /** Internal: selected project when a worker resolves config from a projects array. */
  projectIndex?: number;
}

interface LoadedConfig {
  cwd: string;
  config: LightningConfig;
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

async function loadConfig(overrides: ConfigOverrides): Promise<LoadedConfig> {
  const cwd = path.resolve(overrides.root ?? process.cwd());
  const configFile = findConfigFile(cwd, overrides.config);
  return {
    cwd,
    config: configFile ? await loadConfigFile(cwd, configFile) : {},
  };
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
const VALID_ENVIRONMENTS: readonly TestEnvironment[] = [
  "node",
  "jsdom",
  "happy-dom",
  "edge-runtime",
];
const VALID_COVERAGE_PROVIDERS: readonly CoverageProvider[] = ["v8"];
const VALID_COVERAGE_REPORTERS: readonly CoverageReporter[] = [
  "text",
  "html",
  "lcov",
  "json",
];

function resolvePool(pool: TestPool | undefined): TestPool {
  const resolved = pool ?? "threads";
  if (!VALID_POOLS.includes(resolved)) {
    throw new Error(
      `Invalid pool: ${String(resolved)}. Expected one of ${VALID_POOLS.join(", ")}.`,
    );
  }
  return resolved;
}

function resolveEnvironment(environment: TestEnvironment | undefined): TestEnvironment {
  const resolved = environment ?? "node";
  if (!VALID_ENVIRONMENTS.includes(resolved)) {
    throw new Error(
      `Invalid environment: ${String(resolved)}. Expected one of ${VALID_ENVIRONMENTS.join(", ")}.`,
    );
  }
  return resolved;
}

const VALID_BROWSERS: readonly BrowserName[] = ["chromium", "firefox", "webkit"];
const VALID_BROWSER_PROVIDERS: readonly BrowserProviderName[] = [
  "playwright",
  "webdriverio",
];

function resolveBrowser(
  fileBrowser: BrowserOptions | undefined,
  overrides: ConfigOverrides,
): ResolvedLightningConfig["browser"] {
  const enabled = overrides.browser ?? fileBrowser?.enabled ?? false;
  const provider = fileBrowser?.provider ?? "playwright";
  if (!VALID_BROWSER_PROVIDERS.includes(provider)) {
    throw new Error(
      `Invalid browser provider: ${String(provider)}. Expected one of ${VALID_BROWSER_PROVIDERS.join(", ")}.`,
    );
  }
  if (enabled && provider === "webdriverio") {
    throw new Error(
      "The 'webdriverio' browser provider is not implemented yet; use provider: 'playwright'.",
    );
  }

  const browsers = overrides.browserName ?? fileBrowser?.browsers ?? ["chromium"];
  if (browsers.length === 0) {
    throw new Error("browser.browsers must list at least one browser.");
  }
  for (const name of browsers) {
    if (!VALID_BROWSERS.includes(name)) {
      throw new Error(
        `Invalid browser: ${String(name)}. Expected one of ${VALID_BROWSERS.join(", ")}.`,
      );
    }
  }

  const headless = overrides.headed ? false : (fileBrowser?.headless ?? true);
  return { enabled, provider, browsers: [...new Set(browsers)], headless };
}

function resolveShard(shard: ShardOptions | undefined): ShardOptions | undefined {  if (!shard) return undefined;
  const { index, count } = shard;
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(count) ||
    index < 1 ||
    count < 1 ||
    index > count
  ) {
    throw new Error(`Invalid shard: ${index}/${count}. Expected 1 <= index <= count.`);
  }
  return shard;
}

function resolveCoverageThresholds(
  thresholds: CoverageThresholds | undefined,
): CoverageThresholds | undefined {
  if (!thresholds) return undefined;
  for (const key of ["lines", "functions", "statements", "branches"] as const) {
    const value = thresholds[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(
        `Invalid coverage threshold for ${key}: ${String(value)}. Expected a finite number between 0 and 100.`,
      );
    }
  }
  return thresholds;
}

function resolveCoverage(
  fileCoverage: CoverageOptions | undefined,
  overrides: ConfigOverrides,
): ResolvedLightningConfig["coverage"] {
  const enabled = overrides.coverage ?? fileCoverage?.enabled ?? false;
  const provider = overrides.coverageProvider ?? fileCoverage?.provider ?? "v8";
  if (!VALID_COVERAGE_PROVIDERS.includes(provider)) {
    throw new Error(
      `Invalid coverage provider: ${String(provider)}. Expected one of ${VALID_COVERAGE_PROVIDERS.join(", ")}.`,
    );
  }

  const reporter = overrides.coverageReporter ?? fileCoverage?.reporter ?? ["text"];
  for (const r of reporter) {
    if (!VALID_COVERAGE_REPORTERS.includes(r)) {
      throw new Error(
        `Invalid coverage reporter: ${String(r)}. Expected one of ${VALID_COVERAGE_REPORTERS.join(", ")}.`,
      );
    }
  }

  const thresholds = resolveCoverageThresholds(fileCoverage?.thresholds);

  return {
    enabled,
    provider,
    reporter,
    reportsDirectory:
      overrides.coverageReportsDirectory ?? fileCoverage?.reportsDirectory ?? "coverage",
    include: fileCoverage?.include ?? DEFAULT_COVERAGE_INCLUDE,
    exclude: fileCoverage?.exclude ?? DEFAULT_COVERAGE_EXCLUDE,
    ...(thresholds ? { thresholds } : {}),
  };
}

function mergeTestOptions(
  base: TestOptions | undefined,
  project: TestOptions | undefined,
): TestOptions {
  const thresholds = project?.coverage?.thresholds ?? base?.coverage?.thresholds;
  return {
    ...(base ?? {}),
    ...(project ?? {}),
    poolOptions: {
      ...(base?.poolOptions ?? {}),
      ...(project?.poolOptions ?? {}),
    },
    coverage: {
      ...(base?.coverage ?? {}),
      ...(project?.coverage ?? {}),
      ...(thresholds ? { thresholds } : {}),
    },
    browser: {
      ...(base?.browser ?? {}),
      ...(project?.browser ?? {}),
    },
  };
}

function resolveRoot(cwd: string, root: string | undefined): string {
  if (!root) return cwd;
  return path.isAbsolute(root) ? root : path.resolve(cwd, root);
}

function normalizeReporters(reporters: ReporterConfig[] | undefined): ReporterConfig[] {
  return reporters && reporters.length > 0 ? reporters : ["default"];
}

function resolveOne(
  loaded: LoadedConfig,
  overrides: ConfigOverrides,
  project: ProjectConfig | undefined,
  projectIndex: number | undefined,
): ResolvedLightningConfig {
  const fileConfig = loaded.config;
  const fileTest = mergeTestOptions(fileConfig.test, project?.test);

  const {
    test: _omitBaseTest,
    root: _omitBaseRoot,
    projects: _omitProjects,
    ...baseNasti
  } = fileConfig;
  const {
    test: _omitProjectTest,
    root: _omitProjectRoot,
    name: _omitProjectName,
    ...projectNasti
  } = project ?? {};

  const configuredRoot = project?.root ?? fileConfig.root;
  // `loaded.cwd` is process.cwd() or CLI --root. Config/project roots still apply
  // relative to that discovery base so multi-project roots remain distinct.
  const root = resolveRoot(loaded.cwd, configuredRoot);

  const coverage = resolveCoverage(fileTest.coverage, overrides);
  const shard = resolveShard(overrides.shard ?? fileTest.shard);
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
  const nastiPlugins = [
    createMockTransformPlugin(),
    ...(baseNasti.plugins ?? []),
    ...(projectNasti.plugins ?? []),
  ];

  const resolved: ResolvedLightningConfig = {
    root,
    include: fileTest.include ?? DEFAULT_INCLUDE,
    exclude: fileTest.exclude ?? DEFAULT_EXCLUDE,
    globals: overrides.globals ?? fileTest.globals ?? false,
    testTimeout: overrides.testTimeout ?? fileTest.testTimeout ?? 5000,
    reporters: overrides.reporter
      ? [overrides.reporter]
      : normalizeReporters(fileTest.reporters),
    pool,
    poolOptions: { maxWorkers },
    isolate: overrides.isolate ?? fileTest.isolate ?? true,
    retry: Math.max(0, overrides.retry ?? fileTest.retry ?? 0),
    repeats: Math.max(1, overrides.repeats ?? fileTest.repeats ?? 1),
    updateSnapshots: overrides.update ?? fileTest.update ?? false,
    snapshotDir: fileTest.snapshotDir ?? "__snapshots__",
    environment: resolveEnvironment(overrides.environment ?? fileTest.environment),
    browser: resolveBrowser(fileTest.browser, overrides),
    coverage,
    ...(shard ? { shard } : {}),
    ...(project?.name ? { projectName: project.name } : {}),
    nasti: {
      ...baseNasti,
      ...projectNasti,
      plugins: nastiPlugins,
      root,
      logLevel: overrides.silent
        ? "silent"
        : (projectNasti.logLevel ?? baseNasti.logLevel ?? "silent"),
    },
  };
  if (namePattern) resolved.testNamePattern = namePattern;
  if (projectIndex !== undefined && !resolved.projectName) {
    resolved.projectName = `project-${projectIndex + 1}`;
  }
  return resolved;
}

export async function resolveLightningConfig(
  overrides: ConfigOverrides = {},
): Promise<ResolvedLightningConfig> {
  const loaded = await loadConfig(overrides);
  const projects = loaded.config.projects ?? [];
  if (overrides.projectIndex !== undefined) {
    const project = projects[overrides.projectIndex];
    if (!project) {
      throw new Error(`Project index out of range: ${overrides.projectIndex}`);
    }
    return resolveOne(loaded, overrides, project, overrides.projectIndex);
  }
  return resolveOne(loaded, overrides, undefined, undefined);
}

export async function resolveLightningConfigs(
  overrides: ConfigOverrides = {},
): Promise<Array<{ config: ResolvedLightningConfig; overrides: ConfigOverrides }>> {
  const loaded = await loadConfig(overrides);
  const projects = loaded.config.projects ?? [];
  if (projects.length === 0) {
    return [{ config: resolveOne(loaded, overrides, undefined, undefined), overrides }];
  }

  return projects.map((project, index) => ({
    config: resolveOne(loaded, overrides, project, index),
    overrides: { ...overrides, projectIndex: index },
  }));
}
