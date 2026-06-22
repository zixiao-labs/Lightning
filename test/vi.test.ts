import { afterEach, describe, expect, test, vi } from "@lightning-js/lightning";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("vi runtime", () => {
  test("vi.fn tracks calls and return values", () => {
    const add = vi.fn((a: number, b: number) => a + b).mockName("add");
    expect(add(1, 2)).toBe(3);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(1, 2);
    expect(add).toHaveReturnedWith(3);
    expect(add.getMockName()).toBe("add");
  });

  test("vi.spyOn restores original methods", () => {
    const target = {
      greet(name: string) {
        return `hello ${name}`;
      },
    };
    const spy = vi.spyOn(target, "greet").mockReturnValue("mocked");
    expect(target.greet("amiya")).toBe("mocked");
    expect(spy).toHaveBeenCalledWith("amiya");
    spy.mockRestore();
    expect(target.greet("amiya")).toBe("hello amiya");
  });

  test("stubGlobal and stubEnv are reversible", () => {
    vi.stubGlobal("__LIGHTNING_TEST_GLOBAL__", 123);
    expect((globalThis as any).__LIGHTNING_TEST_GLOBAL__).toBe(123);

    vi.stubEnv("LIGHTNING_TEST_ENV", "yes");
    expect(process.env.LIGHTNING_TEST_ENV).toBe("yes");
  });

  test("fake timers advance timeout, interval and Date.now", () => {
    vi.useFakeTimers({ now: new Date("2024-01-01T00:00:00Z") });
    const calls: string[] = [];
    setTimeout(() => calls.push("timeout"), 50);
    const interval = setInterval(() => calls.push(`interval:${Date.now()}`), 25);

    vi.advanceTimersByTime(25);
    expect(calls).toEqual(["interval:1704067200025"]);
    vi.advanceTimersByTime(25);
    expect(calls).toEqual(["interval:1704067200025", "timeout", "interval:1704067200050"]);
    clearInterval(interval);
  });
});
