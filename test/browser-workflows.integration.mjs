/**
 * Real-browser regression: pnpm build && node --test test/browser-workflows.integration.mjs
 * Requires Playwright with an installed Chromium, just like browser mode itself.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = new URL("./__fixtures__/browser-workflows/", import.meta.url);

async function temporaryFixture(t) {
  const dir = await mkdtemp(path.join(root, "test/.browser-workflows-"));
  await cp(fixture, dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function start(args) {
  const child = spawn(process.execPath, ["bin/lightning.mjs", ...args], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, output: () => output };
}

async function waitFor(run, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate(run.output())) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Browser workflow timed out:\n${run.output()}`);
}

async function finish(run) {
  const result = await Promise.race([
    run.exited,
    new Promise((_, reject) => {
      const timer = setTimeout(() => {
        run.child.kill("SIGKILL");
        reject(new Error(`Browser workflow did not exit:\n${run.output()}`));
      }, 15000);
      timer.unref();
    }),
  ]);
  return result;
}

test("Chromium coverage reports executed project JavaScript", { timeout: 30000 }, async (t) => {
  const dir = await temporaryFixture(t);
  const run = start(["run", "--root", dir, "--coverage"]);
  t.after(() => { if (run.child.exitCode === null) run.child.kill("SIGKILL"); });
  assert.equal((await finish(run)).code, 0, run.output());
  const report = JSON.parse(await readFile(path.join(dir, "coverage/coverage-final.json"), "utf8"));
  const source = Object.values(report).find((file) => file.path.endsWith("/value.ts"));
  assert.ok(source, "project source appears in coverage");
  assert.ok(Object.values(source.s).some((hits) => hits > 0), "executed source has statement hits");
  assert.ok(Object.values(source.f).some((hits) => hits > 0), "executed source has function hits");
});

test("Firefox and WebKit coverage fail explicitly before browser launch", { timeout: 30000 }, async (t) => {
  const dir = await temporaryFixture(t);
  for (const browser of ["firefox", "webkit"]) {
    const run = start(["run", "--root", dir, "--coverage", "--browser-name", browser]);
    assert.notEqual((await finish(run)).code, 0, run.output());
    assert.match(run.output(), /coverage requires Chromium/i);
    assert.doesNotMatch(run.output(), /Executable doesn't exist/);
  }
});

test("Istanbul collects original-source counters in Chromium", { timeout: 30000 }, async (t) => {
  const dir = await temporaryFixture(t);
  const run = start(["run", "--root", dir, "--coverage", "--coverage-provider", "istanbul"]);
  assert.equal((await finish(run)).code, 0, run.output());
  const report = JSON.parse(await readFile(path.join(dir, "coverage/coverage-final.json"), "utf8"));
  const source = report[path.join(dir, "value.ts")];
  assert.ok(Object.values(source.f).some((hits) => hits > 0));
});

test("browser watch reruns affected dependencies and batches changes during a run", { timeout: 45000 }, async (t) => {
  const dir = await temporaryFixture(t);
  const run = start(["watch", "--root", dir]);
  t.after(async () => {
    if (run.child.exitCode === null) run.child.kill("SIGTERM");
    await finish(run);
  });
  const readyCount = (output) => (output.match(/Browser watch ready/g) ?? []).length;
  await waitFor(run, (output) => readyCount(output) === 1);
  await writeFile(path.join(dir, "value.ts"), "export function value(): number { return 2; }\n");
  await waitFor(run, (output) => output.includes("VALUE:2"));
  // These changes land during the delayed test, and must yield exactly one
  // subsequent pool containing the final source, not concurrent runs.
  await writeFile(path.join(dir, "value.ts"), "export function value(): number { return 3; }\n");
  await writeFile(path.join(dir, "value.ts"), "export function value(): number { return 4; }\n");
  await waitFor(run, (output) => readyCount(output) === 3);
  assert.match(run.output(), /VALUE:4/);
  assert.equal((run.output().match(/UNRELATED/g) ?? []).length, 1, run.output());
  assert.doesNotMatch(run.output(), /failed|SSR|running once/i);
  run.child.kill("SIGTERM");
  const result = await finish(run);
  assert.equal(result.code, 0, run.output());
  assert.equal(result.signal, null);
  assert.match(run.output(), /browser watch stopped/);
});
