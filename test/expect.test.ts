import { describe, expect, test } from "@lightning-js/lightning";

describe("expect matchers", () => {
  test("object, collection and asymmetric matchers", () => {
    expect({
      id: 1,
      name: "bolt",
      meta: { tags: ["fast", "esm"] },
    }).toMatchObject({
      id: expect.any(Number),
      meta: { tags: expect.arrayContaining(["fast"]) },
    });
    expect([1, { nested: true }]).toContainEqual({ nested: true });
    expect("lightning").toEqual(expect.stringContaining("light"));
    expect({ value: "abc-123" }).toEqual({
      value: expect.stringMatching(/abc-\d+/),
    });
  });

  test("numeric, property and inline snapshot matchers", () => {
    expect(10).toBeGreaterThan(5);
    expect(10).toBeLessThanOrEqual(10);
    expect(0.1 + 0.2).toBeCloseTo(0.3, 5);
    expect({ a: { b: ["x"] } }).toHaveProperty("a.b.0", "x");
    expect({ ok: true }).toMatchInlineSnapshot("{ ok: true }");
  });

  test("resolves, rejects and poll", async () => {
    await expect(Promise.resolve({ ok: true })).resolves.toMatchObject({
      ok: true,
    });
    await expect(Promise.reject(new Error("boom"))).rejects.toThrow("boom");

    let value = 0;
    setTimeout(() => {
      value = 3;
    }, 20);
    await expect.poll(() => value, { timeout: 500, interval: 10 }).toBe(3);
  });

  test("assertion counts and custom matchers", () => {
    expect.assertions(2);
    expect.extend({
      toBeWithin(actual: unknown, floor: unknown, ceiling: unknown) {
        const pass =
          typeof actual === "number" &&
          actual >= Number(floor) &&
          actual <= Number(ceiling);
        return {
          pass,
          actual,
          expected: [floor, ceiling],
          message: () => `expected ${actual} to be within ${floor}..${ceiling}`,
        };
      },
    });

    (expect(5) as any).toBeWithin(1, 10);
    expect("abc").toHaveLength(3);
  });
});
