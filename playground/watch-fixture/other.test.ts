// Independent of util.ts — must NOT rerun when util.ts changes.
import { test, expect } from "@lightning-js/lightning";

test("independent arithmetic", () => {
  expect(2 + 2).toBe(4);
});
