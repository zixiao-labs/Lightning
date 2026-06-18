import { describe, test, expect } from "@lightning-js/lightning";

// This file intentionally contains a failing test to demonstrate Lightning's
// failure reporting (diff + stack) and non-zero exit code.
describe("intentional failures (demo)", () => {
  test("this one fails on purpose", () => {
    const received = { id: 1, name: "lightning", fast: true };
    expect(received).toEqual({ id: 1, name: "lightning", fast: false });
  });

  test("this one passes", () => {
    expect(2 ** 10).toBe(1024);
  });
});
