import { afterEach, beforeEach, describe, expect, test, vi } from "@lightning-js/lightning";
import { double } from "./mock-target.ts";

vi.mock("./mock-target.ts", () => ({ double: (n: number) => n * 100 }));

/**
 * Exercises the shared runtime (spies, fake timers, module mocks, async
 * matchers) inside a real browser page — the same `vi`/`expect` API as Node
 * mode.
 */
describe("runtime APIs in the browser", () => {
  beforeEach(() => {
    document.title = "lightning-browser";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("vi.fn and vi.spyOn work against browser objects", () => {
    const handler = vi.fn();
    const button = document.createElement("button");
    button.addEventListener("click", handler);
    button.click();
    button.click();
    expect(handler).toHaveBeenCalledTimes(2);

    const spy = vi.spyOn(document, "title", "get");
    expect(document.title).toBe("lightning-browser");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test("fake timers control the page clock", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    setTimeout(tick, 1_000);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  test("vi.mock intercepts module imports in the browser", () => {
    expect(double(2)).toBe(200);
  });

  test("async assertions resolve against browser APIs", async () => {
    const blob = new Blob(["lightning"], { type: "text/plain" });
    await expect(blob.text()).resolves.toBe("lightning");
  });
});
