import { expectTypeOf } from "@lightning-js/lightning";

const twice = (value: number): number => value * 2;
expectTypeOf(twice).parameters.toEqualTypeOf<[number]>();
expectTypeOf(twice).returns.toEqualTypeOf<number>();
