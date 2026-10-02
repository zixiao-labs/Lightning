import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnvDefine, loadEnv, ssrDefineOverrides, NastiEnvironment } from "@nasti-toolchain/nasti";
import type { EnvironmentInstance, NastiPlugin, ResolvedConfig } from "@nasti-toolchain/nasti";
import { transformSync } from "oxc-transform";
import { moduleRunnerTransform } from "rolldown/experimental";
import remapping from "@jridgewell/remapping";
import { decode, encode } from "@jridgewell/sourcemap-codec";
import { glob } from "tinyglobby";
import MagicString from "magic-string";
import { rewriteImportSources } from "../node/compatibility.ts";
import type { ResolvedLightningConfig, V8CoverageScript } from "../types.ts";
import type { CoverageSource } from "./index.ts";

type SourceMap = NonNullable<V8CoverageScript["sourceMap"]>;
const runnerArgs = [
  "__vite_ssr_exports__", "__vite_ssr_import__", "__vite_ssr_dynamic_import__",
  "__vite_ssr_exportAll__", "__vite_ssr_import_meta__",
];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => Function;
const strictPrefix = '"use strict";';

export interface CoverageSourceLoader {
  plugin: NastiPlugin;
  loadSource(file: string): Promise<CoverageSource>;
  enrichScripts(scripts: V8CoverageScript[]): Promise<V8CoverageScript[]>;
}

/**
 * Nasti 2.5 drops OXC and module-runner maps. Recreate those transforms, and
 * accept their maps only when the complete generated script matches inspector.
 * This adapter deliberately rejects upstream plugin rewrites: Nasti's post hook
 * cannot recover the discarded map chain, so pretending it maps raw TS is unsafe.
 */
export function createCoverageSourceLoader(config: ResolvedLightningConfig): CoverageSourceLoader {
  let resolved: ResolvedConfig | undefined;
  let environment: EnvironmentInstance | undefined;
  const captured = new Map<string, { code: string; environment: EnvironmentInstance }>();
  const generated = new Map<string, Promise<CoverageSource>>();
  const included = glob(config.coverage.include, {
    cwd: config.root, absolute: true, ignore: config.coverage.exclude,
  }).then((files) => new Set(files.map((file) => path.resolve(file))));
  const plugin: NastiPlugin = {
    name: "lightning:coverage-source",
    enforce: "post",
    configResolved(value) { resolved = value; },
    applyToEnvironment(value) {
      if (value.consumer !== "server") return false;
      environment = value;
      return true;
    },
    transform(code, id) {
      if (this.environment?.consumer === "server") {
        captured.set(id, { code, environment: this.environment });
        generated.delete(id);
      }
      return null;
    },
  };

  async function regenerate(id: string): Promise<CoverageSource> {
    if (!resolved || !environment) throw new Error("Coverage source loader must be installed before Nasti creates its server environment");
    const file = id.split("?")[0]!;
    let input = captured.get(id);
    if (!input) {
      const container = environment instanceof NastiEnvironment ? environment.pluginContainer : undefined;
      if (!container) throw new Error(`Missing Nasti plugin container for coverage: ${file}`);
      const loaded = await container.load(id);
      const code = loaded == null ? await readFile(file, "utf8") : typeof loaded === "string" ? loaded : loaded.code;
      await container.transform(code, id);
      input = captured.get(id);
    }
    if (!input) throw new Error(`Missing Nasti post-transform coverage source: ${file}`);
    const original = await readFile(file, "utf8");
    let compatibilityMap: SourceMap | undefined;
    if (input.code !== original) {
      const rewritten = rewriteImportSources(original, file);
      if (rewritten.code === input.code && rewritten.map) compatibilityMap = rewritten.map;
      else {
        throw new Error(`Cannot map coverage for ${file}: a Nasti load/transform plugin changed source without a recoverable map chain`);
      }
    }
    let code = input.code;
    let compilerMap: SourceMap | undefined;
    const isTS = /\.(?:ts|mts|cts|tsx)$/.test(file);
    const isJSX = /\.(?:jsx|tsx)$/.test(file);
    if (isTS || isJSX) {
      const transformed = transformSync(file, code, {
        ...(isTS ? { typescript: {} } : {}),
        ...(isJSX ? { jsx: {
          runtime: resolved.framework === "react" ? resolved.react.jsxRuntime : "automatic",
          importSource: resolved.framework === "react" ? resolved.react.jsxImportSource : "vue",
          refresh: false,
        } } : {}),
        sourcemap: true,
        target: input.environment.options.build.target,
      });
      if (transformed.errors.length) throw new Error(`Coverage OXC transform failed for ${file}: ${transformed.errors.map((error) => error.message).join("\n")}`);
      code = transformed.code;
      if (!transformed.map) throw new Error(`Missing OXC coverage map for ${file}`);
      compilerMap = JSON.parse(JSON.stringify(transformed.map)) as SourceMap;
      compilerMap.sources = [file];
      compilerMap.sourcesContent = [input.code];
    }
    const define = buildEnvDefine(
      loadEnv(resolved.mode, resolved.root, resolved.envPrefix),
      resolved.mode, ssrDefineOverrides(input.environment.consumer),
    );
    const environmentMaps: SourceMap[] = [];
    for (const [key, value] of Object.entries(define)) {
      const source = new MagicString(code);
      for (let index = code.indexOf(key); index !== -1; index = code.indexOf(key, index + key.length)) {
        source.overwrite(index, index + key.length, value);
      }
      const replaced = source.toString();
      if (replaced !== code) {
        environmentMaps.unshift(JSON.parse(source.generateMap({ source: file, includeContent: true, hires: true }).toString()));
        code = replaced;
      }
    }
    const runner = await moduleRunnerTransform(id, code, { sourcemap: true });
    if (runner.errors.length || !runner.map) throw new Error(`Cannot regenerate Nasti module-runner coverage map: ${file}`);
    const runnerMap = JSON.parse(JSON.stringify(runner.map)) as SourceMap;
    runnerMap.sources = [file];
    runnerMap.sourcesContent = [code];
    const chain = [runnerMap, ...environmentMaps, ...(compilerMap ? [compilerMap] : []), ...(compatibilityMap ? [compatibilityMap] : [])];
    const combined: SourceMap = chain.length > 1
      ? JSON.parse(JSON.stringify(remapping(chain.map((map) => JSON.stringify(map)), () => null)))
      : runnerMap;
    const mappings = decode(combined.mappings);
    for (const segment of mappings[0] ?? []) segment[0] += strictPrefix.length;
    const sourceMap: SourceMap = {
      ...combined,
      version: 3,
      sources: [file],
      sourcesContent: [original],
      mappings: encode([[], [], ...mappings]),
    };
    const body = `${strictPrefix}${runner.code}\n//# sourceURL=${id}`;
    // Inspector exposes constructor scripts as parenthesized expressions.
    // The header occupies two unmapped lines; parentheses are on those lines.
    const source = `(${new AsyncFunction(...runnerArgs, body).toString()})`;
    return { source, sourceMap };
  }

  function loadSource(file: string): Promise<CoverageSource> {
    let result = generated.get(file);
    if (!result) {
      result = regenerate(file);
      generated.set(file, result);
    }
    return result;
  }

  async function enrichScripts(scripts: V8CoverageScript[]): Promise<V8CoverageScript[]> {
    const allowed = await included;
    return Promise.all(scripts.map(async (script) => {
      let file: string;
      try { file = script.url.startsWith("file:") ? fileURLToPath(script.url) : script.url.split("?")[0]!; }
      catch { return script; }
      if (!allowed.has(file) || script.sourceMap) return script;
      const regenerated = await loadSource(script.url.startsWith("file:") ? file : script.url);
      if (script.source !== regenerated.source) {
        throw new Error(`Nasti coverage source mismatch for ${file}: refusing an inaccurate source map`);
      }
      return { ...script, sourceMap: regenerated.sourceMap! };
    }));
  }
  return { plugin, loadSource, enrichScripts };
}
