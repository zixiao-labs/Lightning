/** Shared equality rule for assertions and conditional mocks, without runtime cycles. */
export interface AsymmetricMatcherInterface {
  asymmetricMatch(value: unknown): boolean;
  toString(): string;
}

export function isAsymmetricMatcher(value: unknown): value is AsymmetricMatcherInterface {
  return Boolean(value && typeof value === "object" &&
    typeof (value as AsymmetricMatcherInterface).asymmetricMatch === "function");
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (isAsymmetricMatcher(b)) return b.asymmetricMatch(a);
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof RegExp || b instanceof RegExp) {
    return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    for (const [key, value] of a) if (!b.has(key) || !deepEqual(value, b.get(key))) return false;
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
    const remaining = [...b];
    return [...a].every((actual) => {
      const index = remaining.findIndex((expected) => deepEqual(actual, expected));
      if (index === -1) return false;
      remaining.splice(index, 1);
      return true;
    });
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Reflect.ownKeys(a);
  const bKeys = Reflect.ownKeys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    Object.prototype.propertyIsEnumerable.call(a, key) === Object.prototype.propertyIsEnumerable.call(b, key) &&
    Object.prototype.hasOwnProperty.call(b, key) &&
    deepEqual((a as Record<PropertyKey, unknown>)[key], (b as Record<PropertyKey, unknown>)[key]));
}
