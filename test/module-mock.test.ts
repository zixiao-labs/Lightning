import { describe, expect, test, vi } from "@lightning-js/lightning";
import { greet, meaning } from "./mock-target.ts";

vi.mock("./mock-target.ts", () => ({
  meaning: 7,
  greet: vi.fn((name: string) => `mocked ${name}`),
}));

describe("vi.mock transform", () => {
  test("hoists mock registration before rewritten static imports", () => {
    expect(meaning).toBe(7);
    expect(greet("nasti")).toBe("mocked nasti");
    expect(greet).toHaveBeenCalledWith("nasti");
  });
});
