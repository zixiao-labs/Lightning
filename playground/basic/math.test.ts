import { describe, test, expect, beforeEach, afterEach } from "@lightning-js/lightning";

// Exercises TS types + top-level await (proves the moduleRunnerTransform path).
interface Vec {
  x: number;
  y: number;
}
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });

const loaded: number = await Promise.resolve(41);

test("top-level await runs before tests", () => {
  expect(loaded + 1).toBe(42);
});

describe("math", () => {
  test("adds primitives", () => {
    expect(1 + 2).toBe(3);
  });

  test("adds vectors (deep equal)", () => {
    expect(add({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
  });

  test("not.toBe", () => {
    expect("a").not.toBe("b");
  });
});

describe("hooks order", () => {
  const calls: string[] = [];
  beforeEach(() => {
    calls.push("before");
  });
  afterEach(() => {
    calls.push("after");
  });

  test("first", () => {
    expect(calls).toEqual(["before"]);
  });

  test("second sees prior after()", () => {
    // `calls` persists across tests in this describe: the first test's beforeEach
    // pushed "before", its afterEach pushed "after", then this test's beforeEach
    // pushed "before" again — proving afterEach fired between the two tests.
    expect(calls).toEqual(["before", "after", "before"]);
  });
});

test.skip("skipped test", () => {
  expect(true).toBe(false);
});

test.todo("implement subtraction");

describe.each([
  { a: 2, b: 3, sum: 5 },
  { a: 10, b: 5, sum: 15 },
])("each $a + $b", ({ a, b, sum }) => {
  test("equals the expected sum", () => {
    expect(a + b).toBe(sum);
  });
});
