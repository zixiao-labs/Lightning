/** Include @lightning-js/lightning/globals in tsconfig "types" for globals: true. */
declare global {
  var test: typeof import("./runtime/collect.ts").test;
  var it: typeof import("./runtime/collect.ts").it;
  var describe: typeof import("./runtime/collect.ts").describe;
  var bench: typeof import("./bench/index.ts").bench;
  var expect: typeof import("./expect/index.ts").expect;
  var vi: typeof import("./mock/index.ts").vi;
  var jest: typeof import("./mock/index.ts").vi;
  var beforeAll: typeof import("./runtime/collect.ts").beforeAll;
  var afterAll: typeof import("./runtime/collect.ts").afterAll;
  var beforeEach: typeof import("./runtime/collect.ts").beforeEach;
  var afterEach: typeof import("./runtime/collect.ts").afterEach;
  var onTestFinished: typeof import("./runtime/context.ts").onTestFinished;
  var onTestFailed: typeof import("./runtime/context.ts").onTestFailed;
}
export {};
