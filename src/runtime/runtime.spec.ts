import { test as check } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, finishCollection, startCollection, test } from "./collect.ts";
import { runSuiteTree } from "./run.ts";
import { expect } from "../expect/index.ts";
import { onTestFailed, onTestFinished } from "./context.ts";

async function run(collect: () => void) {
  startCollection();
  collect();
  const { root, hasOnly } = finishCollection();
  return runSuiteTree(root, { hasOnly, defaultTimeout: 100, retry: 0, repeats: 1 });
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

check("options, old signature, conditional APIs and for preserve row arrays", async () => {
  const rows: unknown[] = [];
  const results = await run(() => {
    test("old", async () => { await delay(3); }, 50);
    describe("options", { timeout: 0 }, () => {
      describe("nested", () => test("inherits", async context => {
        assert.equal(context.task.timeout, 0);
        await delay(4);
      }));
    });
    test.skipIf(true)("skip", () => assert.fail());
    test.runIf(false)("skip2", () => assert.fail());
    describe.skipIf(true)("skip suite", () => test("skipped", () => assert.fail()));
    describe.runIf(false)("skip suite 2", () => test("skipped", () => assert.fail()));
    test.runIf(true)("runs", () => {});
    test("options skip", { skip: true }, () => assert.fail());
    test("implicit todo");
    describe.for([[1, 2]])("row", value => {
      rows.push(value);
      test.for([[3, 4]])("test row", (row, context) => {
        rows.push(row);
        context.expect(row).toEqual([3, 4]);
      });
    });
  });
  assert.deepEqual(rows, [[1, 2], [3, 4]]);
  assert.equal(results.filter(result => result.state === "skip").length, 5);
  assert.equal(results.filter(result => result.state === "todo").length, 1);
  assert.equal(results.filter(result => result.state === "fail").length, 0);
});

check("concurrent assertion counts and soft errors stay scoped across awaits", async () => {
  const results = await run(() => {
    test.concurrent("first", async ({ expect: local }) => {
      local.assertions(2);
      await delay(10);
      local(1).toBe(1);
      await local(Promise.resolve(2)).resolves.toBe(2);
    });
    test.concurrent("soft failure", async () => {
      expect.assertions(1);
      expect.soft(1).toBe(2);
      await delay(1);
    });
    test.concurrent("third", async () => {
      expect.assertions(1);
      await delay(4);
      expect(true).toBe(true);
    });
  });
  assert.deepEqual(results.map(result => result.state), ["pass", "fail", "pass"]);
});

check("late assertions from a timed-out attempt cannot change the next test", async () => {
  const results = await run(() => {
    test("times out", { timeout: 3 }, async () => {
      await delay(12);
      expect(true).toBe(true);
    });
    test("next", async () => {
      expect.assertions(1);
      await delay(20);
      expect(true).toBe(true);
    });
  });
  assert.deepEqual(results.map(result => result.state), ["fail", "pass"]);
});

check("cleanup drains after failures and cleanup failures cannot be expected away", async () => {
  const calls: string[] = [];
  const results = await run(() => {
    afterEach(() => { calls.push("after"); throw Error("after error"); });
    afterEach(() => { calls.push("after2"); });
    test.fails("expected", ({ onTestFinished: finish }) => {
      finish(() => { calls.push("finish"); });
      finish(() => { calls.push("finish2"); throw Error("cleanup"); });
      onTestFailed(() => { calls.push("failed"); });
      throw Error("expected");
    });
  });
  assert.equal(results[0]?.state, "fail");
  assert.deepEqual(calls, ["after", "after2", "failed", "finish2", "finish"]);
});

check("expected failures only invert body failures", async () => {
  const results = await run(() => {
    test.fails("fails", () => { throw Error("yes"); });
    test("option fails", { fails: true }, () => expect(1).toBe(2));
    test.fails("passes", () => {});
    describe("setup", () => {
      beforeEach(() => { throw Error("setup"); });
      test.fails("setup fails", () => { throw Error("body"); });
    });
    describe("soft teardown", () => {
      afterEach(context => context.expect.soft(1).toBe(2));
      test.fails("teardown fails", () => { throw Error("body"); });
    });
  });
  assert.deepEqual(results.map(result => result.state), ["pass", "pass", "fail", "fail", "fail"]);
});

check("per-test hooks receive context and their assertions count toward the test", async () => {
  let taskName = "";
  const results = await run(() => {
    beforeEach(context => {
      context.expect.assertions(2);
      taskName = context.task.name;
    });
    afterEach(({ expect: local }) => { local(true).toBe(true); });
    test("context", context => {
      context.expect(1).toBe(1);
      context.onTestFinished(finished => assert.equal(finished, context));
    });
  });
  assert.equal(taskName, "context");
  assert.equal(results[0]?.state, "pass");
});

check("beforeAll failure still runs afterAll and preserves skipped tasks", async () => {
  let cleaned = false;
  const results = await run(() => {
    beforeAll(() => { throw Error("setup"); });
    afterAll(() => { cleaned = true; });
    test("blocked", () => assert.fail());
    test.skip("skip", () => assert.fail());
  });
  assert.equal(cleaned, true);
  assert.deepEqual(results.map(result => result.state), ["fail", "skip"]);
});

check("returned hook cleanups drain even when later setup fails", async () => {
  const calls: string[] = [];
  await run(() => {
    beforeAll(() => () => { calls.push("suite cleanup"); });
    beforeAll(() => { throw Error("later setup"); });
    afterAll(() => { calls.push("afterAll"); });
    test("blocked", () => assert.fail());
  });
  assert.deepEqual(calls, ["afterAll", "suite cleanup"]);
  calls.length = 0;
  await run(() => {
    beforeEach(() => () => { calls.push("test cleanup"); });
    beforeEach(() => { throw Error("later setup"); });
    afterEach(() => { calls.push("afterEach"); });
    test("blocked", () => assert.fail());
  });
  assert.deepEqual(calls, ["afterEach", "test cleanup"]);
});

check("finished callbacks run per retry and throwing callbacks produce results", async () => {
  let attempts = 0;
  let cleaned = 0;
  const results = await run(() => {
    test("retry", { retry: 1 }, context => {
      context.onTestFinished(() => { cleaned++; });
      if (++attempts === 1) throw Error("retry");
    });
    test("cleanup failure", () => {
      onTestFinished(() => { throw Error("cleanup failure"); });
    });
  });
  assert.equal(cleaned, 2);
  assert.deepEqual(results.map(result => result.state), ["pass", "fail"]);
});

check("unawaited assertions fail while awaited assertions pass", async () => {
  const results = await run(() => {
    test("unawaited", () => { expect(Promise.resolve(1)).resolves.toBe(1); });
    test("awaited", async () => { await expect(Promise.resolve(1)).resolves.toBe(1); });
  });
  assert.deepEqual(results.map(result => result.state), ["fail", "pass"]);
  assert.match(results[0]?.error?.message ?? "", /not awaited/);
});

check("poll aborts a hung callback within its own timeout", async () => {
  let signal: AbortSignal | undefined;
  const results = await run(() => {
    test("hung poll", async () => {
      await expect.poll(context => {
        signal = context.signal;
        return new Promise(() => {});
      }, { timeout: 10 }).toBe(1);
    });
    test("successful poll", async () => {
      let count = 0;
      await expect.poll(() => ++count, { timeout: 30, interval: 1 }).toBe(2);
    });
  });
  assert.deepEqual(results.map(result => result.state), ["fail", "pass"]);
  assert.match(results[0]?.error?.message ?? "", /expect.poll timed out/);
  assert.equal(signal?.aborted, true);
});

check("browser fallback preserves imported and contextual expect across awaits", () => {
  const script = `
    import assert from 'node:assert/strict';
    process.getBuiltinModule = undefined;
    const { startCollection, finishCollection, test } = await import('./src/runtime/collect.ts');
    const { runSuiteTree } = await import('./src/runtime/run.ts');
    const { expect } = await import('./src/expect/index.ts');
    startCollection();
    test.concurrent('one', async ({expect}) => {
      expect.assertions(2);
      await new Promise(r => setTimeout(r, 8));
      expect(1).toBe(1);
      await expect(Promise.resolve(2)).resolves.toBe(2);
    });
    test.concurrent('two', async ({expect}) => {
      expect.assertions(1);
      await new Promise(r => setTimeout(r, 2));
      await expect(Promise.resolve(2)).resolves.toBe(2);
    });
    test.concurrent('missing assertion', async () => {
      await Promise.resolve();
      expect.assertions(1);
    });
    test.concurrent('soft failure', async () => {
      await Promise.resolve();
      expect.soft(1).toBe(2);
    });
    test.concurrent('unawaited failure', async () => {
      await Promise.resolve();
      expect(Promise.resolve(1)).resolves.toBe(2);
    });
    const {root, hasOnly} = finishCollection();
    const results = await runSuiteTree(root, {hasOnly, defaultTimeout:100, retry:0, repeats:1});
    assert.deepEqual(results.map(r=>r.state), ['pass','pass','fail','fail','fail']);
  `;
  execFileSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", script], {
    cwd: new URL("../../", import.meta.url),
    stdio: "pipe",
  });
});
