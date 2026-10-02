import { describe, expect, test, vi } from "@lightning-js/lightning";

describe("Vitest 5 conditional mocks", () => {
  test("behaviors match FIFO and use the original implementation on unmatched calls", () => {
    const mock = vi.fn((id: unknown) => `original:${id}`);
    const chain = vi.when(mock)
      .calledWith({ id: 1 }).thenReturn("specific")
      .calledWith(expect.any(Number)).thenReturn("number");
    expect(mock({ id: 1 })).toBe("specific");
    expect(mock(2)).toBe("number");
    expect(mock("other")).toBe("original:other");
    expect(chain.exhausted).toBe(true);
    expect(chain).toHaveBeenExhausted();
    expect(mock).toHaveBeenCalledTimes(3);
  });
  test("actions stack LIFO, finite actions consume their declared count", async () => {
    const mock = vi.fn<(...args: any[]) => Promise<string>>();
    const chain = vi.when(mock).calledWith(1).thenResolve("fallback")
      .thenRejectOnce(new Error("retry")).thenResolve("first", { times: 2 });
    await expect(mock(1)).resolves.toBe("first");
    expect(chain.exhausted).toBe(false);
    expect(chain).not.toHaveBeenExhausted();
    await expect(mock(1)).resolves.toBe("first");
    await expect(mock(1)).rejects.toThrow("retry");
    await expect(mock(1)).resolves.toBe("fallback");
    expect(chain.exhausted).toBe(true);
  });
  test("broad registrations merge subsequent matching behaviors", () => {
    const mock = vi.fn();
    vi.when(mock).calledWith(expect.any(String)).thenReturn("user")
      .calledWith("admin@example.com").thenReturnOnce("admin");
    expect(mock("user@example.com")).toBe("admin");
    expect(mock("user@example.com")).toBe("user");
  });
  test("reset and disposal remove behaviors, and strict unmatched calls fail", () => {
    const mock = vi.fn((..._args: unknown[]) => "original");
    const chain = vi.when(mock, { onUnmatched: "throw" }).calledWith(1).thenReturn("mock");
    expect(() => mock(2)).toThrow("no behavior defined");
    chain[Symbol.dispose]();
    expect(mock(1)).toBe("original");
    vi.when(mock).calledWith(1).thenReturn("new");
    mock.mockReset();
    expect(mock(1)).toBeUndefined();
    vi.when(mock).calledWith(2).thenReturn("after reset");
    expect(mock(2)).toBe("after reset");
    expect(vi.isWhenChain(chain)).toBe(true);
    expect(vi.isWhenChain(mock)).toBe(false);
  });
});
