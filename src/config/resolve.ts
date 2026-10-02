/**
 * Resolve the effective Lightning config: defaults ← `lightning.config.*` ← CLI flags.
 *
 * TS configs and their local helpers are bundled, then imported as native ESM.
 * Package imports use Node's ESM resolution, just like JS configs.
 */
import { existsSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { glob } from "tinyglobby";
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
import { createCompatibilityPlugin } from "../node/compatibility.ts";
import { mapJestConfig } from "./compat.ts";
import { createIstanbulCoveragePlugin } from "../coverage/istanbul.ts";
import { importConfig } from "./load.ts";
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
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
  "jest.config.ts",
  "jest.config.mjs",
  "jest.config.js",
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
  "**/*.{test,spec}-d.ts",
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
  typecheck?: boolean;
  tsconfig?: string;
  benchmarkBaseline?: string;
  benchmarkCompare?: string;
  benchmarkThreshold?: number;
  project?: string;
  outputFile?: string;
  /** Internal: selected project when a worker resolves config from a projects array. */
  projectIndex?: number;
}

interface LoadedConfig {
  cwd: string;
  config: LightningConfig;
}

function displayName(name: TestOptions["name"]): string | undefined {
  return typeof name === "string" ? name : name?.label;
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
  file: string,
): Promise<LightningConfig> {
  const mod = await importConfig(file);
  const config = await (mod.default ?? mod.config ?? {});
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Config ${file} must export an object; config factory functions are not supported.`);
  }
  return /(?:^|[/\\])jest\.config\./.test(file)
    ? mapJestConfig(config as Record<string, unknown>)
    : config as LightningConfig;
}

async function loadConfig(overrides: ConfigOverrides): Promise<LoadedConfig> {
  const cwd = path.resolve(overrides.root ?? process.cwd());
  const configFile = findConfigFile(cwd, overrides.config);
  return {
    cwd,
    config: configFile ? await loadConfigFile(configFile) : {},
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

function integerOption(value: number, name: string, minimum = 0): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`Invalid ${name}: ${String(value)}. Expected an integer >= ${minimum}.`);
  }
  return value;
}

const VALID_POOLS: readonly TestPool[] = ["threads", "forks", "inline"];
const VALID_ENVIRONMENTS: readonly TestEnvironment[] = [
  "node",
  "jsdom",
  "happy-dom",
  "edge-runtime",
];
const VALID_COVERAGE_PROVIDERS: readonly CoverageProvider[] = ["v8", "istanbul"];
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

function resolveShard(shard: ShardOptions | undefined): ShardOptions | undefined {
  if (!shard) return undefined;
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
    typecheck: { ...(base?.typecheck ?? {}), ...(project?.typecheck ?? {}) },
    benchmark: { ...(base?.benchmark ?? {}), ...(project?.benchmark ?? {}) },
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
    projects: _omitProjectProjects,
    extends: _omitExtends,
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
  const maxWorkers = integerOption(
    overrides.maxWorkers ??
      fileTest.maxWorkers ??
      fileTest.poolOptions?.maxWorkers ??
      defaultMaxWorkers(),
    "maxWorkers", 1,
  );
  const pool = resolvePool(overrides.pool ?? fileTest.pool);
  const tsconfig = overrides.tsconfig ?? fileTest.typecheck?.tsconfig;
  const outputFile = overrides.outputFile ?? fileTest.outputFile;
  const projectName = displayName(project?.test?.name) ?? project?.name ?? displayName(fileTest.name);
  const nastiPlugins = [
    createCompatibilityPlugin(),
    createMockTransformPlugin(),
    ...(baseNasti.plugins ?? []),
    ...(projectNasti.plugins ?? []),
  ];

  const resolved: ResolvedLightningConfig = {
    root,
    include: fileTest.include ?? DEFAULT_INCLUDE,
    exclude: fileTest.exclude ?? DEFAULT_EXCLUDE,
    typecheck: {
      enabled: overrides.typecheck ?? fileTest.typecheck?.enabled ?? false,
      ...(tsconfig ? { tsconfig } : {}),
    },
    benchmark: {
      ...fileTest.benchmark,
      ...(overrides.benchmarkBaseline ? { baseline: overrides.benchmarkBaseline } : {}),
      ...(overrides.benchmarkCompare ? { compare: overrides.benchmarkCompare } : {}),
      ...(overrides.benchmarkThreshold !== undefined ? { threshold: overrides.benchmarkThreshold } : {}),
    },
    ...(outputFile ? { outputFile } : {}),
    globals: overrides.globals ?? fileTest.globals ?? false,
    testTimeout: integerOption(overrides.testTimeout ?? fileTest.testTimeout ?? 5000, "testTimeout"),
    reporters: overrides.reporter
      ? [overrides.reporter]
      : normalizeReporters(fileTest.reporters),
    pool,
    poolOptions: { maxWorkers },
    isolate: overrides.isolate ?? fileTest.isolate ?? true,
    retry: integerOption(overrides.retry ?? fileTest.retry ?? 0, "retry"),
    repeats: integerOption(overrides.repeats ?? fileTest.repeats ?? 1, "repeats", 1),
    updateSnapshots: overrides.update ?? fileTest.update ?? false,
    snapshotDir: fileTest.snapshotDir ?? "__snapshots__",
    environment: resolveEnvironment(overrides.environment ?? fileTest.environment),
    browser: resolveBrowser(fileTest.browser, overrides),
    coverage,
    ...(shard ? { shard } : {}),
    ...(projectName ? { projectName } : {}),
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
  if (coverage.enabled && coverage.provider === "istanbul") {
    resolved.nasti.plugins = [createIstanbulCoveragePlugin(resolved), ...(resolved.nasti.plugins ?? [])];
  }
  if (projectIndex !== undefined && !resolved.projectName) {
    resolved.projectName = `project-${projectIndex + 1}`;
  }
  return resolved;
}

/** Expand paths deterministically; workers reconstruct the same flattened index. */
async function expandProjects(loaded: LoadedConfig): Promise<ProjectConfig[] | undefined> {
  const rootEntries = loaded.config.test?.projects ?? loaded.config.projects;
  if (!rootEntries?.length) return undefined;
  const leaves: ProjectConfig[] = [];
  async function walk(base: LightningConfig, cwd: string, entries: NonNullable<LightningConfig["projects"]>, names: string[], stack: Set<string>): Promise<void> {
    for (const entry of entries) {
      let children: Array<{ config: ProjectConfig; cwd: string; path?: string }> = [];
      if (typeof entry === "string") {
        const paths = await glob(entry, {
          cwd, absolute: true, onlyFiles: false,
          ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/.nasti/**"],
        });
        if (!paths.length) throw new Error(`Project path matched no files or directories: ${entry}`);
        for (const matched of paths.sort()) {
          const directory = (await stat(matched)).isDirectory();
          const file = directory ? findConfigFile(matched) : matched;
          const childCwd = directory ? matched : path.dirname(matched);
          const config = file ? await loadConfigFile(file) : {};
          children.push({ config: { ...config, root: resolveRoot(childCwd, config.root) }, cwd: childCwd, ...(file ? { path: file } : {}) });
        }
      } else if (entry && typeof entry === "object") {
        children = [{ config: entry, cwd }];
      } else throw new Error("Projects must be config objects or path/glob strings.");
      for (const child of children) {
        if (child.path && stack.has(child.path)) throw new Error(`Circular project configuration: ${child.path}`);
        const nextStack = new Set(stack);
        if (child.path) nextStack.add(child.path);
        const inherit = child.config.extends !== false;
        const { test: _baseTest, projects: _baseProjects, ...baseNasti } = base;
        const { test: _childTest, projects: _childProjects, extends: _extends, ...childNasti } = child.config;
        const effective: ProjectConfig = {
          ...(inherit ? baseNasti : {}),
          ...childNasti,
          root: resolveRoot(child.cwd, child.config.root ?? (inherit ? base.root : undefined)),
          plugins: [...(inherit ? base.plugins ?? [] : []), ...(child.config.plugins ?? [])],
          test: mergeTestOptions(inherit ? base.test : undefined, child.config.test),
        };
        delete effective.test!.projects;
        const ownName = displayName(child.config.test?.name) ?? child.config.name;
        const pathNames = ownName ? [...names, ownName] : names;
        const nested = child.config.test?.projects ?? child.config.projects;
        if (nested?.length) await walk(effective, child.cwd, nested, pathNames, nextStack);
        else {
          if (pathNames.length) effective.test!.name = pathNames.length === 1 ? pathNames[0]! : `${pathNames[0]} (${pathNames.slice(1).join(" > ")})`;
          leaves.push(effective);
        }
      }
    }
  }
  await walk(loaded.config, loaded.cwd, rootEntries, [], new Set());
  return leaves;
}

export async function resolveLightningConfigs(
  overrides: ConfigOverrides = {},
): Promise<Array<{ config: ResolvedLightningConfig; overrides: ConfigOverrides }>> {
  const loaded = await loadConfig(overrides);
  const projects = await expandProjects(loaded);
  const entries = projects ? projects.map((project, index) => ({
    config: resolveOne({ cwd: loaded.cwd, config: {} }, overrides, project, index),
    overrides: { ...overrides, projectIndex: index },
  })) : [{ config: resolveOne(loaded, overrides, undefined, undefined), overrides }];
  if (overrides.projectIndex !== undefined) {
    const selected = entries[overrides.projectIndex];
    if (!selected) throw new Error(`Project index out of range: ${overrides.projectIndex}`);
    return [selected];
  }
  const names = entries.map((entry) => entry.config.projectName).filter(Boolean);
  if (new Set(names).size !== names.length) throw new Error("Project names must be unique.");
  if (!overrides.project) return entries;
  const selected = entries.filter((entry) => entry.config.projectName === overrides.project || entry.config.projectName?.startsWith(`${overrides.project} (`));
  if (!selected.length) throw new Error(`Unknown project: ${overrides.project}`);
  return selected;
}

export async function resolveLightningConfig(overrides: ConfigOverrides = {}): Promise<ResolvedLightningConfig> {
  return (await resolveLightningConfigs(overrides))[0]!.config;
}

/** Reporters belong to the root run, not to individual project executions. */
export async function resolveRootLightningConfig(overrides: ConfigOverrides = {}): Promise<ResolvedLightningConfig> {
  return resolveOne(await loadConfig(overrides), overrides, undefined, undefined);
}
