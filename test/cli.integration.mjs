/** Built-package/CLI contract tests: pnpm build && node --test test/cli.integration.mjs */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
async function fixture(t, files) {
  const dir = await mkdtemp(path.join(root, "test/.cli-integration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "node_modules/@lightning-js"), { recursive: true });
  await symlink(root, path.join(dir, "node_modules/@lightning-js/lightning"), "dir");
  await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return dir;
}
async function cli(dir, flags = [], command = "run") {
  try {
    const result = await exec(process.execPath, [path.join(root, "bin/lightning.mjs"), command, "--root", dir, ...flags], {
      timeout: 25000, maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, ...result };
  } catch (error) {
    if (!Number.isInteger(error.code)) throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}
const config = (options) => `export default ${JSON.stringify(options)};`;
const simple = 'import {test,expect} from "vitest"; test("works",()=>expect(2).toBe(2));';

test("declaration tests never execute even with broad include and no exclusions", { timeout: 60000 }, async (t) => {
  const dir = await fixture(t, {
    "lightning.config.mjs": config({ test: { include: ["*.ts"], exclude: [], typecheck: { enabled: true } } }),
    "runtime.test.ts": simple,
    "never.test-d.ts": 'throw new Error("DECLARATION EXECUTED"); const n: number = 1;',
  });
  const result = await cli(dir, ["--reporter", "json"]);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.files.length, 2);
  assert.equal(report.files.find((file) => file.filepath.endsWith("never.test-d.ts")).results[0].fullName, "typecheck");
  assert.doesNotMatch(result.stdout + result.stderr, /DECLARATION EXECUTED/);
});

test("Vitest config path/glob projects inherit defaults and retain worker indexes", { timeout: 60000 }, async (t) => {
  const dir = await fixture(t, {
    "vitest.config.ts": 'import {defineConfig} from "vitest/config"; export default defineConfig({test:{maxWorkers:1,projects:["packages/*"]}});',
    "packages/a/vitest.config.ts": 'import {defineProject} from "vitest/config"; export default defineProject({test:{name:{label:"unit"},globals:true}});',
    "packages/a/a.test.ts": 'test("global API",()=>expect(1).toBe(1));',
    "packages/b/lightning.config.mjs": config({ test: { name: "integration" } }),
    "packages/b/b.test.ts": simple,
  });
  const all = await cli(dir, ["--reporter", "json"]);
  assert.equal(all.code, 0, all.stderr);
  const report = JSON.parse(all.stdout);
  assert.deepEqual(report.files.map((file) => file.projectName), ["unit", "integration"]);
  const selected = await cli(dir, ["--project", "integration", "--pool", "forks", "--reporter", "json"]);
  assert.equal(selected.code, 0, selected.stderr);
  assert.equal(JSON.parse(selected.stdout).files.length, 1);
  const missing = await cli(dir, ["--project", "missing"]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /Unknown project/);
});

test("type testing resolves migrated Vitest imports and typed globals without execution", { timeout: 60000 }, async (t) => {
  const dir = await fixture(t, {
    "lightning.config.mjs": config({ test: { globals: true, typecheck: { enabled: true } } }),
    "api.test-d.ts": 'import {expectTypeOf,assertType} from "vitest"; expectTypeOf<number>().toEqualTypeOf<number>(); assertType<number>(1); test("typed global",()=>expect(1).toBe(1)); throw new Error("types executed");',
  });
  const result = await cli(dir, ["--reporter", "json"]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).summary.passedTests, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /types executed/);
});

test("nested project containers inherit configs and support parent-name filtering", { timeout: 60000 }, async (t) => {
  const dir = await fixture(t, {
    "lightning.config.mjs": config({ test: { projects: ["packages/app/lightning.config.mjs"] } }),
    "packages/app/lightning.config.mjs": config({ test: { name: "app", globals: true, projects: [
      { root: "unit", test: { name: "unit" } },
      { root: "integration", extends: false, test: { name: "integration" } },
    ] } }),
    "packages/app/unit/a.test.ts": 'test("inherited globals",()=>expect(1).toBe(1));',
    "packages/app/integration/b.test.ts": simple,
  });
  const result = await cli(dir, ["--project", "app", "--reporter", "json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).files.map((file) => file.projectName), ["app (unit)", "app (integration)"]);
});

test("focus scanning ignores comments and honors aliased options-form only", { timeout: 60000 }, async (t) => {
  const dir = await fixture(t, {
    "a.test.ts": 'import {test as spec,expect} from "vitest"; // test.only("unused",()=>{});\nconst text="test.only("; spec("selected",{only:true},()=>expect(1).toBe(1));',
    "b.test.ts": simple,
  });
  const result = await cli(dir, ["--reporter", "json"]);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.passedTests, 1);
  assert.equal(report.summary.skippedTests, 1);
  await writeFile(path.join(dir, "a.test.ts"), 'import {test,expect} from "vitest"; // test.only("unused",()=>{});\ntest("regular",()=>expect(1).toBe(1));');
  const ordinary = await cli(dir, ["--reporter", "json"]);
  assert.equal(JSON.parse(ordinary.stdout).summary.passedTests, 2);
});

test("ordinary test bodies cannot focus the run through nested test or benchmark APIs", { timeout: 60000 }, async (t) => {
  const dir = await fixture(t, {
    "a.test.ts": `
      import {test, expect, describeBench} from "@lightning-js/lightning";
      test("outer",()=>{
        const nested=()=>test.only("not collected",()=>{});
        const benchmark=()=>describeBench.only("not collected",()=>{});
        expect(typeof nested).toBe("function");
        expect(typeof benchmark).toBe("function");
      });
    `,
    "b.test.ts": simple,
  });
  const result = await cli(dir, ["--reporter", "json"]);
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(result.stdout).summary;
  assert.equal(summary.passedTests, 2);
  assert.equal(summary.skippedTests, 0);
});

test("the dogfood suite executes its tests rather than returning an all-skipped success", { timeout: 60000 }, async () => {
  const result = await cli(root, ["--reporter", "json"]);
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(result.stdout).summary;
  assert.ok(summary.passedTests >= 41, `Expected actual execution, received ${JSON.stringify(summary)}`);
  assert.equal(summary.skippedTests, 0);
});

for (const pool of ["threads", "forks", "inline"]) {
  test(`unhandled rejections fail the file in ${pool}`, { timeout: 60000 }, async (t) => {
    const dir = await fixture(t, {
      "bad.test.ts": 'import {test} from "vitest"; test("leak",()=>{Promise.reject(new Error("rejection sentinel"));});',
    });
    const result = await cli(dir, ["--pool", pool, "--reporter", "json"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /rejection sentinel/);
    assert.equal(JSON.parse(result.stdout).summary.failedFiles, 1);
  });
}

for (const provider of ["v8", "istanbul"]) {
  test(`${provider} maps TS, includes unexecuted files and gates real branch coverage`, { timeout: 60000 }, async (t) => {
    const dir = await fixture(t, {
      "lightning.config.mjs": config({ test: { coverage: {
        enabled: true, provider, include: ["source.ts", "unused.ts"], reporter: ["json", "html", "lcov"],
      } } }),
      "source.ts": 'import {vi} from "vitest";\ninterface Input { value: number }\nexport const mock=vi.fn();\nexport function classify(input: Input): string {\n  if (import.meta.env.SSR && input.value > 0) return "positive";\n  return "other";\n}\n',
      "unused.ts": 'export function never(value: number) { return value + 1; }',
      "source.test.ts": 'import {test,expect} from "vitest"; import {classify} from "./source"; test("positive",()=>expect(classify({value:1})).toBe("positive"));',
    });
    const result = await cli(dir);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const report = JSON.parse(await readFile(path.join(dir, "coverage/coverage-final.json"), "utf8"));
    const source = report[path.join(dir, "source.ts")];
    assert.ok(Object.values(source.s).some((hits) => hits > 0));
    assert.ok(Object.values(source.b).flat().some((hits) => hits === 0), "unexecuted branch is not reported as covered");
    assert.ok(Object.values(report[path.join(dir, "unused.ts")].s).every((hits) => hits === 0));
    assert.match(await readFile(path.join(dir, "coverage/index.html"), "utf8"), /source.ts/);
    assert.match(await readFile(path.join(dir, "coverage/lcov.info"), "utf8"), /BRDA:/);
    await writeFile(path.join(dir, "lightning.config.mjs"), config({ test: { coverage: {
      enabled: true, provider, include: ["source.ts", "unused.ts"], reporter: ["json"], thresholds: { branches: 100 },
    } } }));
    assert.notEqual((await cli(dir)).code, 0);
  });
}

test("bench supports context fixtures and globals, and writes a baseline", { timeout: 60000 }, async (t) => {
  const dir = await fixture(t, {
    "lightning.config.mjs": config({ test: { globals: true } }),
    "sample.bench.ts": `
      bench("legacy",()=>JSON.parse("{}"),{time:1,iterations:2,warmup:false});
      test("context",async({bench,expect})=>{
        const values=await bench.compare(bench("parse",()=>JSON.parse("[]"),{time:1,iterations:2,warmup:false}));
        expect(values.get("parse").throughput.mean).toBeGreaterThan(0);
      });
    `,
  });
  const result = await cli(dir, ["--baseline", "baseline.json", "--reporter", "json"], "bench");
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const baseline = JSON.parse(await readFile(path.join(dir, "baseline.json"), "utf8"));
  assert.equal(Object.keys(baseline.benchmarks).length, 2);
});

test("Jest subset config and globals migrate, unsupported config fails explicitly", { timeout: 60000 }, async (t) => {
  const dir = await fixture(t, {
    "jest.config.mjs": config({ testMatch: ["<rootDir>/*.test.ts"], testEnvironment: "node", testTimeout: 2000 }),
    "mock.test.ts": 'test("jest alias",()=>{const mock=jest.fn(()=>1);expect(mock()).toBe(1);});',
  });
  assert.equal((await cli(dir)).code, 0);
  await writeFile(path.join(dir, "jest.config.mjs"), config({ transform: {} }));
  const invalid = await cli(dir);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /Unsupported Jest config options: transform/);
});

test("reporter output paths and failures are observable", { timeout: 60000 }, async (t) => {
  const dir = await fixture(t, {
    "sample.test.ts": 'import {test,expect} from "vitest";test("escape < &",()=>expect(1).toBe(1));test.skip("skip",()=>{});',
    "custom.mjs": 'export default class Reporter { onFileDone(){throw new Error("reporter sentinel");} }',
  });
  assert.equal((await cli(dir, ["--reporter", "junit", "--output-file", "artifacts/results.xml"])).code, 0);
  assert.match(await readFile(path.join(dir, "artifacts/results.xml"), "utf8"), /escape &lt; &amp;/);
  const result = await cli(dir, ["--reporter", "./custom.mjs"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /reporter sentinel/);
});

test("invalid worker counts cannot produce a false-green empty run", { timeout: 60000 }, async (t) => {
  const dir = await fixture(t, {
    "sample.test.ts": simple,
    "lightning.config.mjs": "export default {test:{maxWorkers:NaN}};",
  });
  const result = await cli(dir);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Invalid maxWorkers/);
});

test("CI shards are disjoint and cover the complete discovered file set", { timeout: 60000 }, async (t) => {
  const dir = await fixture(t, { "a.test.ts": simple, "b.test.ts": simple, "c.test.ts": simple });
  const seen = [];
  for (let index = 1; index <= 3; index++) {
    const result = await cli(dir, ["--shard", `${index}/3`, "--reporter", "json"]);
    assert.equal(result.code, 0, result.stderr);
    seen.push(...JSON.parse(result.stdout).files.map((file) => path.basename(file.filepath)));
  }
  assert.deepEqual(seen.sort(), ["a.test.ts", "b.test.ts", "c.test.ts"]);
});
