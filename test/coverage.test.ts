import { readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test } from "@lightning-js/lightning";
import { createCoverageReport, CoverageSession } from "../src/coverage/index.ts";
import { createCoverageSourceLoader } from "../src/coverage/nasti.ts";
import { createServer } from "@nasti-toolchain/nasti";
import type { ResolvedLightningConfig } from "../src/types.ts";

const root = fileURLToPath(new URL("./fixtures/coverage/", import.meta.url));
const file = path.join(root, "branch.ts");

async function transformed() {
  const result = ts.transpileModule(await readFile(file, "utf8"), {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, sourceMap: true, inlineSources: true },
  });
  const sourceMap = JSON.parse(result.sourceMapText!);
  sourceMap.sources = [file];
  return { source: result.outputText.replace(/\/\/# sourceMappingURL=.*$/m, ""), sourceMap };
}

async function scenario(run: (config: ResolvedLightningConfig) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "lightning-coverage-"));
  try {
    await run({
      root,
      coverage: { include: ["*.ts"], exclude: [], reporter: ["json", "html", "lcov"], reportsDirectory: dir },
    } as unknown as ResolvedLightningConfig);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

describe("source-mapped V8 coverage", () => {
  test("validates regenerated maps against real Nasti AsyncFunction source", async () => {
    await scenario(async (config) => {
      const loader = createCoverageSourceLoader(config);
      const server = await createServer({
        root, plugins: [loader.plugin],
        server: { hmr: false }, logLevel: "silent",
      });
      try {
        const session = new CoverageSession();
        await session.start();
        const exports = await server.ssrLoadModule(file);
        (exports.classify as (input: { value: number }) => string)({ value: 1 });
        const scripts = (await session.stop()).filter((script) => script.url === file);
        expect(scripts.length).toBeGreaterThan(0);
        const enriched = await loader.enrichScripts(scripts);
        const result = await createCoverageReport(config, enriched, loader);
        expect(result.summary.branches.pct).toBeLessThan(100);
        expect(result.summary.lines.covered).toBeGreaterThan(0);
        const json = JSON.parse(await readFile(path.join(config.coverage.reportsDirectory, "coverage-final.json"), "utf8"));
        const statements = json[file].statementMap;
        const otherReturn = Object.keys(statements).find((id) => statements[id].start.line === 9)!;
        const positiveReturn = Object.keys(statements).find((id) => statements[id].start.line === 7)!;
        expect(json[file].s[otherReturn]).toBe(0);
        expect(json[file].s[positiveReturn]).toBeGreaterThan(0);
        await expect(loader.enrichScripts(scripts.map((script) => ({ ...script, source: `${script.source}\n` })))).rejects.toThrow("source mismatch");
      } finally { await server.close(); }
    });
  });

  test("captures evaluated source, maps TS branches and merges separate runs", async () => {
    await scenario(async (config) => {
      const input = await transformed();
      const scripts = [];
      for (const value of [1, 0]) {
        const session = new CoverageSession();
        await session.start();
        const exports: { classify?: (input: { value: number }) => string } = {};
        new Function("exports", `${input.source}\n//# sourceURL=${file}`)(exports);
        exports.classify!({ value });
        const captured = (await session.stop()).filter((script) => script.url === file);
        expect(captured.length).toBeGreaterThan(0);
        expect(captured[0]!.source).toContain("function classify");
        scripts.push(...captured.map((script) => ({
          ...script,
          // V8's Function constructor prepends two wrapper lines.
          sourceMap: { ...input.sourceMap, mappings: `;;${input.sourceMap.mappings}` },
        })));
      }
      const partial = await createCoverageReport(config, scripts.slice(0, 1));
      expect(partial.summary.branches.pct).toBeLessThan(100);
      const merged = await createCoverageReport(config, scripts);
      expect(merged.summary.branches.pct).toBe(100);
      const json = JSON.parse(await readFile(path.join(config.coverage.reportsDirectory, "coverage-final.json"), "utf8"));
      expect(json[file].statementMap).toBeDefined();
      expect(json[file].branchMap).toBeDefined();
      expect(await readFile(path.join(config.coverage.reportsDirectory, "lcov.info"), "utf8")).toContain("BRDA:");
      expect(await readFile(path.join(config.coverage.reportsDirectory, "index.html"), "utf8")).toContain("branch.ts");
    });
  });

  test("includes unexecuted TS with zero hits, applies exclusions and gates branches", async () => {
    await scenario(async (config) => {
      config.coverage.thresholds = { lines: 100, branches: 100 };
      const result = await createCoverageReport(config, [], { loadSource: transformed });
      expect(result.files.length).toBe(1);
      expect(result.summary.lines.covered).toBe(0);
      expect(result.thresholdErrors.length).toBeGreaterThan(0);
      config.coverage.exclude = ["branch.ts"];
      const excluded = await createCoverageReport(config, []);
      expect(excluded.files.length).toBe(0);
    });
  });

  test("refuses to interpret generated offsets against original TS", async () => {
    await scenario(async (config) => {
      await expect(createCoverageReport(config, [{
        scriptId: "1", url: file, source: "function classify() {}", functions: [],
      }])).rejects.toThrow("Missing source map");
    });
  });
});
