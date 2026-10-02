import type { LightningConfig } from "../types.ts";

/** Deliberately small, explicit Jest migration surface. No silent config loss. */
export function mapJestConfig(config: Record<string, unknown>): LightningConfig {
  const supported = new Set([
    "rootDir", "testMatch", "testEnvironment", "testTimeout", "injectGlobals",
    "maxWorkers", "collectCoverage", "collectCoverageFrom", "coverageDirectory",
  ]);
  const unsupported = Object.keys(config).filter((key) => !supported.has(key));
  if (unsupported.length) {
    throw new Error(`Unsupported Jest config options: ${unsupported.join(", ")}. Migrate these options to lightning.config.ts explicitly.`);
  }
  const string = (key: string): string | undefined => {
    const value = config[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`Jest ${key} must be a string`);
    return value;
  };
  const array = (key: string): string[] | undefined => {
    const value = config[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new Error(`Jest ${key} must be an array of strings`);
    }
    return value.map((entry: string) => entry.replace(/^<rootDir>\//, ""));
  };
  const boolean = (key: string): boolean | undefined => {
    const value = config[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") throw new Error(`Jest ${key} must be a boolean`);
    return value;
  };
  const number = (key: string): number | undefined => {
    const value = config[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`Jest ${key} must be a non-negative integer`);
    }
    return value;
  };
  const root = string("rootDir");
  const include = array("testMatch");
  const environment = string("testEnvironment");
  if (environment && !["node", "jsdom", "happy-dom", "edge-runtime"].includes(environment)) {
    throw new Error(`Unsupported Jest testEnvironment: ${environment}`);
  }
  const testTimeout = number("testTimeout");
  const maxWorkers = number("maxWorkers");
  const globals = boolean("injectGlobals") ?? true;
  const enabled = boolean("collectCoverage");
  const coverageInclude = array("collectCoverageFrom");
  const reportsDirectory = string("coverageDirectory");
  return {
    ...(root ? { root } : {}),
    test: {
      globals,
      ...(include ? { include } : {}),
      ...(environment ? { environment: environment as "node" | "jsdom" | "happy-dom" | "edge-runtime" } : {}),
      ...(testTimeout !== undefined ? { testTimeout } : {}),
      ...(maxWorkers !== undefined ? { maxWorkers } : {}),
      coverage: {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(coverageInclude ? { include: coverageInclude } : {}),
        ...(reportsDirectory ? { reportsDirectory } : {}),
      },
    },
  };
}
