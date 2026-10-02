import { expect, test } from "@lightning-js/lightning";
import { value } from "./value.ts";

console.log(`VALUE:${value()}`);
test("fresh browser realm and dependency", async () => {
  expect(typeof window).toBe("object");
  expect(value()).toBeGreaterThan(0);
  await new Promise((resolve) => setTimeout(resolve, 350));
});
