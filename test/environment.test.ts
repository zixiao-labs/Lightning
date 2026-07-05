// @lightning-environment edge-runtime
import { describe, expect, test } from "@lightning-js/lightning";

describe("test environments", () => {
  test("docblock selects the edge-runtime environment", () => {
    expect((globalThis as any).self).toBe(globalThis);
    expect(typeof fetch).toBe("function");
    expect(typeof Request).toBe("function");
    expect(typeof Response).toBe("function");
  });
});
