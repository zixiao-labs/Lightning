import type { LightningConfig, ProjectConfig } from "../types.ts";

/**
 * Identity helper that gives editors full type-checking/autocomplete for
 * `lightning.config.ts`. Mirrors Vitest's `defineConfig`.
 */
export function defineConfig(config: LightningConfig): LightningConfig {
  return config;
}

export function defineProject(config: ProjectConfig): ProjectConfig {
  return config;
}
