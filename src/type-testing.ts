export { expectTypeOf } from "expect-type";

/** Compile-time assignability assertion. It deliberately has no runtime effect. */
export function assertType<T>(_value: T): void {}
