import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "@lightning-js/lightning";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

async function withProject(run: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "lightning-config-")));
  try {
    await mkdir(path.join(root, "node_modules/@nasti-toolchain"), { recursive: true });
    await symlink(
      path.dirname(path.dirname(require.resolve("@nasti-toolchain/nasti"))),
      path.join(root, "node_modules/@nasti-toolchain/nasti"),
      "dir",
    );
    await writeFile(path.join(root, "package.json"), '{"type":"module"}');
    await writeFile(path.join(root, "smoke.test.ts"), `
      import { writeFileSync } from "node:fs";
      test("config loaded", () => {
        expect(1 + 1).toBe(2);
        writeFileSync(new URL("./ran", import.meta.url), "passed");
      });
    `);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCli(root: string, config: string, pool = "inline") {
  const result = await exec(process.execPath, [
    path.join(repo, "bin/lightning.mjs"), "run", "--root", root,
    "--config", config, "--reporter=github-actions", "--pool", pool,
    "--maxWorkers", "1",
  ], { timeout: 20_000 });
  expect(await readFile(path.join(root, "ran"), "utf8")).toBe("passed");
  return result;
}

const options = '{ test: { globals: true, include: ["smoke.test.ts"] } }';

describe("config loading", () => {
  for (const [extension, pool] of [["ts", "threads"], ["mts", "forks"], ["js", "inline"], ["mjs", "inline"]] as const) {
    test(`${extension} configs import Nasti's ESM entry (${pool})`, async () => {
      await withProject(async (root) => {
        const config = `lightning.e2e.config.${extension}`;
        await writeFile(path.join(root, config), `
          import { defineConfig } from "@nasti-toolchain/nasti";
          export default defineConfig(${options});
        `);
        await runCli(root, config, pool);
        expect((await readdir(root)).filter((name) => name.includes(".lightning-"))).toEqual([]);
      });
    }, 30_000);
  }

  test("TS helpers preserve file URLs, named exports, and package import conditions", async () => {
    await withProject(async (root) => {
      const helperDir = path.join(root, "helpers");
      const dependency = path.join(root, "node_modules/config-dependency");
      await mkdir(helperDir);
      await writeFile(path.join(helperDir, "asset.mjs"), 'export default "helper asset";');
      await mkdir(dependency);
      await writeFile(path.join(dependency, "package.json"), JSON.stringify({
        type: "module",
        exports: { import: "./index.mjs", require: "./index.cjs" },
      }));
      await writeFile(path.join(dependency, "index.mjs"), 'export const value = "esm";');
      await writeFile(path.join(dependency, "index.cjs"), 'throw new Error("wrong require condition");');
      await writeFile(path.join(helperDir, "options.ts"), `
        import { fileURLToPath } from "node:url";
        import { value } from "config-dependency";
        if (value !== "esm") throw new Error("wrong package export");
        if (fileURLToPath(import.meta.url) !== ${JSON.stringify(path.join(helperDir, "options.ts"))})
          throw new Error("wrong helper URL");
        if (import.meta.dirname !== ${JSON.stringify(helperDir)} ||
            import.meta.filename !== fileURLToPath(import.meta.url))
          throw new Error("wrong helper file scope");
        if (import.meta.resolve("./asset.mjs") !== ${JSON.stringify(pathToFileURL(path.join(helperDir, "asset.mjs")).href)})
          throw new Error("wrong helper asset URL");
        const resolve = import.meta.resolve;
        if (resolve("config-dependency") !== ${JSON.stringify(pathToFileURL(path.join(dependency, "index.mjs")).href)})
          throw new Error("wrong resolved package export");
        export const options: { globals: boolean; include: string[] } = ${options}.test;
      `);
      await writeFile(path.join(root, "lightning.config.ts"), `
        import { fileURLToPath } from "node:url";
        const { options } = await import("./helpers/options.ts");
        if (fileURLToPath(import.meta.url) !== ${JSON.stringify(path.join(root, "lightning.config.ts"))})
          throw new Error("wrong config URL");
        export const config = { test: options };
      `);
      await runCli(root, "lightning.config.ts");
    });
  }, 30_000);

  test("failed config evaluation removes the generated module and reports the cause", async () => {
    await withProject(async (root) => {
      await writeFile(path.join(root, "lightning.config.ts"),
        'throw new Error("config evaluation sentinel"); export default {};');
      let failure: { stderr?: string } | undefined;
      try {
        await runCli(root, "lightning.config.ts");
      } catch (error) {
        failure = error as { stderr?: string };
      }
      expect(failure?.stderr).toContain("config evaluation sentinel");
      expect((await readdir(root)).filter((name) => name.includes(".lightning-"))).toEqual([]);
    });
  }, 30_000);
});
