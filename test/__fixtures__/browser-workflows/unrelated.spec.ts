import { expect, test } from "@lightning-js/lightning";

console.log("UNRELATED");
test("unrelated browser spec", () => {
  expect(typeof document).toBe("object");
});
