/**
 * Resolve the effective Lightning config: defaults ← `lightning.config.*` ← CLI flags.
 *
 * A TS/JS config file is loaded through a throwaway Nasti server (`ssrLoadModule`),
 * reusing the same module-runner pipeline that runs the tests — so a `.ts` config with
 * top-level imports just works. The server is only spun up when a config file exists.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "@nasti-toolchain/nasti";
import type { LightningConfig, ResolvedLightningConfig, TestOptions } from "../types.ts";

const CONFIG_NAMES = [
  "lightning.config.ts",
  "lightning.config.mts",
  "lightning.config.js",
  "lightning.config.mjs",
];

const DEFAULT_INCLUDE = ["**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"];
const DEFAULT_EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/.nasti/**"];

/** CLI flags that override file/default config. */
export interface ConfigOverrides {
  root?: string;
  config?: string;
  globals?: boolean;
  testNamePattern?: string;
  reporter?: string;
  silent?: boolean;
}

function findConfigFile(root: string, explicit?: string): string | undefined {
  if (explicit) {
    const abs = path.isAbsolute(explicit) ? explicit : path.join(root, explicit);
    return existsSync(abs) ? abs : undefined;
  }
  for (const name of CONFIG_NAMES) {
    const abs = path.join(root, name);
    if (existsSync(abs)) return abs;
  }
  return undefined;
}

async function loadConfigFile(root: string, file: string): Promise<LightningConfig> {
  // `.mjs`/`.js` (ESM) can be imported directly; `.ts` needs the Nasti runner.
  if (/\.(mjs|js)$/.test(file)) {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
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

export async function resolveLightningConfig(
  overrides: ConfigOverrides = {},
): Promise<ResolvedLightningConfig> {
  const root = path.resolve(overrides.root ?? process.cwd());
  const configFile = findConfigFile(root, overrides.config);

  let fileConfig: LightningConfig = {};
  if (configFile) fileConfig = await loadConfigFile(root, configFile);

  const fileTest: TestOptions = fileConfig.test ?? {};
  const { test: _omitTest, root: _omitRoot, ...nasti } = fileConfig;

  const namePattern = toRegExp(overrides.testNamePattern ?? fileTest.testNamePattern);

  const resolved: ResolvedLightningConfig = {
    root,
    include: fileTest.include ?? DEFAULT_INCLUDE,
    exclude: fileTest.exclude ?? DEFAULT_EXCLUDE,
    globals: overrides.globals ?? fileTest.globals ?? false,
    testTimeout: fileTest.testTimeout ?? 5000,
    reporters: overrides.reporter ? [overrides.reporter] : fileTest.reporters ?? ["default"],
    nasti: { ...nasti, root, logLevel: overrides.silent ? "silent" : nasti.logLevel ?? "silent" },
  };
  if (namePattern) resolved.testNamePattern = namePattern;
  return resolved;
}
