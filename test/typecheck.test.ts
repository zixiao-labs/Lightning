import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ts from "typescript";
import { test, expect, vi } from "@lightning-js/lightning";
import { runTypechecks } from "../src/typecheck/index.ts";
import type { ResolvedLightningConfig } from "../src/types.ts";

test("type tests reuse shared declarations without leaking dependency diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lightning-types-"));
  const reads = new Map<string, number>();
  const readFile = ts.sys.readFile;
  const spy = vi.spyOn(ts.sys, "readFile").mockImplementation((file, encoding) => {
    if (file.endsWith(".d.ts")) reads.set(file, (reads.get(file) ?? 0) + 1);
    return readFile(file, encoding);
  });
  try {
    const passing = path.join(root, "passing.test-d.ts");
    const failing = path.join(root, "failing.test-d.ts");
    const shared = path.join(root, "shared.d.ts");
    await writeFile(shared, "export interface Shared { value: number }");
    await writeFile(passing, 'import type { Shared } from "./shared.js"; export const valid: Shared = { value: 1 };');
    await writeFile(failing, 'import type { Shared } from "./shared.js"; import "./broken.ts"; export const valid: Shared = { value: 1 };');
    await writeFile(path.join(root, "broken.ts"), 'export const broken: number = "bad";');
    const files = await runTypechecks([failing, passing], { root } as ResolvedLightningConfig);
    expect(files[0]!.results[0]!.error!.message).toContain("broken.ts:1:");
    expect(files[1]!.results[0]!.state).toBe("pass");
    expect(reads.get(shared)).toBe(1);
    const libraryReads = [...reads].filter(([file]) => /[/\\]lib\..*\.d\.ts$/.test(file));
    expect(libraryReads.length).toBeGreaterThan(0);
    expect(libraryReads.every(([, count]) => count === 1)).toBe(true);
  } finally {
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("type tests compile without executing, and failures retain file and line", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lightning-types-"));
  try {
    const passing = path.join(root, "passing.test-d.ts");
    const failing = path.join(root, "failing.spec-d.ts");
    await writeFile(passing, 'const value: number = 42;\nthrow new Error("never execute");\nexport {};\n');
    await writeFile(failing, 'const value: number = "wrong";\nexport {};\n');
    const files = await runTypechecks([passing, failing], { root } as ResolvedLightningConfig);
    expect(files[0]!.results[0]!.state).toBe("pass");
    expect(files[1]!.results[0]!.state).toBe("fail");
    expect(files[1]!.results[0]!.error!.message).toContain("failing.spec-d.ts:1:");
    expect(files[1]!.results[0]!.error!.message).toContain("TS2322");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("type dependency failures are attributed only to importing entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lightning-types-"));
  try {
    const passing = path.join(root, "passing.test-d.ts");
    const failing = path.join(root, "failing.test-d.ts");
    await writeFile(passing, "export const valid: number = 1;");
    await writeFile(failing, 'import "./broken.ts";');
    await writeFile(path.join(root, "broken.ts"), 'export const broken: number = "bad";');
    const files = await runTypechecks([passing, failing], { root } as ResolvedLightningConfig);
    expect(files[0]!.results[0]!.state).toBe("pass");
    expect(files[1]!.results[0]!.error!.message).toContain("broken.ts:1:");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
