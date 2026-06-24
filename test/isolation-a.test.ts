import { expect, test } from "@lightning-js/lightning";

test("file A starts with a clean worker global", () => {
  expect((globalThis as any).__LIGHTNING_FILE_ISOLATION__).toBeUndefined();
  (globalThis as any).__LIGHTNING_FILE_ISOLATION__ = "a";
});
