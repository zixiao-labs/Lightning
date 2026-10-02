import { readFile } from "node:fs/promises";
import path from "node:path";
import { glob } from "tinyglobby";
import { createInstrumenter } from "istanbul-lib-instrument";
import libCoverage from "istanbul-lib-coverage";
import type { CoverageMapData } from "istanbul-lib-coverage";
import type { NastiPlugin } from "@nasti-toolchain/nasti";
import type { ResolvedLightningConfig } from "../types.ts";
import { writeCoverageReport } from "./index.ts";

function instrumenter(file: string) {
  return createInstrumenter({
    esModules: true,
    compact: false,
    preserveComments: true,
    produceSourceMap: true,
    coverageVariable: "__lightning_coverage__",
    coverageGlobalScope: "globalThis",
    coverageGlobalScopeFunc: false,
    parserPlugins: [
      ...(/\.[cm]?tsx?$/.test(file) ? ["typescript" as const] : []),
      ...(/\.[jt]sx$/.test(file) ? ["jsx" as const] : []),
    ],
  });
}

async function includedFiles(config: ResolvedLightningConfig): Promise<Set<string>> {
  return new Set((await glob(config.coverage.include, {
    cwd: config.root, ignore: config.coverage.exclude, absolute: true,
  })).map((file) => path.resolve(file)));
}

/** Instrument before compatibility/compiler transforms, against original TS/JS. */
export function createIstanbulCoveragePlugin(config: ResolvedLightningConfig): NastiPlugin {
  const allowed = includedFiles(config);
  return {
    name: "lightning:istanbul",
    enforce: "pre",
    async transform(code, id) {
      const file = id.split("?")[0]!;
      if (!(await allowed).has(file)) return null;
      const original = await readFile(file, "utf8");
      if (code !== original) throw new Error(`Istanbul coverage requires original source at the instrumentation boundary: ${file}`);
      const instance = instrumenter(file);
      return { code: instance.instrumentSync(code, file), map: instance.lastSourceMap() };
    },
  };
}

export async function createIstanbulCoverageReport(config: ResolvedLightningConfig, data: Array<Record<string, unknown>>) {
  const allowed = await includedFiles(config);
  const map = libCoverage.createCoverageMap({});
  for (const entry of data) {
    const filtered = Object.fromEntries(Object.entries(entry).filter(([file]) => allowed.has(path.resolve(file))));
    map.merge(filtered as CoverageMapData);
  }
  for (const file of [...allowed].sort()) {
    if (map.files().includes(file)) continue;
    const instance = instrumenter(file);
    instance.instrumentSync(await readFile(file, "utf8"), file);
    const coverage = instance.lastFileCoverage();
    if (coverage) map.addFileCoverage(coverage);
  }
  return writeCoverageReport(config, map);
}
