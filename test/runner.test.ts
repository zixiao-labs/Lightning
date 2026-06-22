import { afterAll, describe, expect, test } from "@lightning-js/lightning";

describe("runner scheduling", () => {
  test.retry(1)("retries a flaky test", () => {
    const key = "__LIGHTNING_RETRY_COUNT__";
    const current = ((globalThis as any)[key] as number | undefined) ?? 0;
    (globalThis as any)[key] = current + 1;
    expect(current).toBe(1);
  });

  test("custom timeout allows async work", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(true).toBeTruthy();
  }, 200);
});

describe.concurrent("concurrent tests", () => {
  let active = 0;
  let maxActive = 0;

  async function work() {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active--;
  }

  test("first concurrent task", work);
  test("second concurrent task", work);

  afterAll(() => {
    expect(maxActive).toBeGreaterThan(1);
  });
});
