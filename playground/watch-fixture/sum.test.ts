// Transitively depends on util.ts via mid.ts. The smoke test edits util.ts and
// expects ONLY this file to rerun, seeing the *fresh* token through mid.ts.
import { test, expect } from "@lightning-js/lightning";
import { tag } from "./mid.ts";

test("tag reflects the current util token", () => {
  expect(tag).toBe("[ALPHA]");
});
