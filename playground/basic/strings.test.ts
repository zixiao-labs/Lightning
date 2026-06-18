import { describe, test, expect } from "@lightning-js/lightning";

describe("strings & errors", () => {
  test("toBeTruthy / toBeFalsy", () => {
    expect("non-empty").toBeTruthy();
    expect("").toBeFalsy();
  });

  test("toThrow with message match", () => {
    expect(() => {
      throw new Error("boom: bad input");
    }).toThrow("bad input");
  });

  test("not.toThrow", () => {
    expect(() => 1 + 1).not.toThrow();
  });

  test("deep arrays", () => {
    expect([1, [2, 3], { a: 4 }]).toEqual([1, [2, 3], { a: 4 }]);
  });
});
