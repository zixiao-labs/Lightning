import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

test("documentation preview serves both languages without exposing repository files", { timeout: 10000 }, async (t) => {
  const child = spawn(process.execPath, ["website/serve.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => { child.kill("SIGTERM"); await exited; });
  const address = await new Promise((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
    child.once("exit", () => reject(new Error("Documentation server exited before readiness")));
  });
  const response = await fetch(address);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /lang="en"/);
  assert.match(html, /lang="zh-CN"/);
  assert.match(html, /Vitest 5\.0\.3/);
  assert.equal((await fetch(`${address}/package.json`)).status, 404);
});
