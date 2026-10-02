import { assertType, expectTypeOf } from "@lightning-js/lightning";

expectTypeOf({ answer: 42 }).toEqualTypeOf<{ answer: number }>();
assertType<string>("Lightning");
// @ts-expect-error The assertion must reject incompatible values.
assertType<number>("not a number");
// If a runner accidentally evaluates this type-only file it must fail loudly.
throw new Error("Type-test files must NEVER execute");
