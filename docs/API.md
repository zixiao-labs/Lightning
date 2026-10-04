# API reference

Lightning spec files can import the test APIs from `@lightning-js/lightning`.
The package requires Node.js 22.12.0 or newer. This guide describes the shipped
public exports; it is not a promise of complete Vitest or Jest compatibility.

## Test structure and lifecycle

```ts
import {
  afterAll, afterEach, beforeAll, beforeEach,
  describe, expect, test,
} from "@lightning-js/lightning";

describe("string helpers", () => {
  beforeAll(() => {
    // Runs once before this suite.
    return () => {
      // Runs during suite teardown, including after failures.
    };
  });

  beforeEach(() => {
    // Runs before each test in this suite.
    return () => {
      // Runs during test teardown, including after failures.
    };
  });

  test("normalizes a value", () => {
    expect(" Lightning ".trim()).toBe("Lightning");
  });

  afterEach(() => {
    // Runs after each test. Return values are ignored.
  });

  afterAll(() => {
    // Runs once after this suite. Return values are ignored.
  });
});
```

`it` is an alias of `test`. Tests and hooks may be synchronous or asynchronous.
Only `beforeAll` and `beforeEach` execute returned cleanup functions during suite
and test teardown, respectively, including after setup or test failures.
Return values from `afterAll` and `afterEach` are ignored. Use `onTestFinished`
and `onTestFailed` from the package root to register test-scoped cleanup and
failure callbacks.

## Test options and parameterized cases

The options form is `test(name, options, fn)`. Supported runnable options include
`skip`, `only`, `todo`, `fails`, `timeout`, `retry`, `repeats`, `concurrent`,
and `sequential`. Timeout values are milliseconds; retry counts specify additional
attempts after a failure.

```ts
import { expect, test } from "@lightning-js/lightning";

test("retries a transient operation", { retry: 1, timeout: 2_000 }, async () => {
  expect(await Promise.resolve("ready")).toBe("ready");
});

test.for([[1, 2, 3], [2, 3, 5]] as const)(
  "adds %i and %i",
  ([left, right, sum], { expect }) => {
    expect(left + right).toBe(sum);
  },
);
```

`test.each` is also available for table-driven cases. Conditional helpers include
`skipIf` and `runIf`. Use `.skip`, `.only`, `.todo`, `.fails`, `.concurrent`, or
`.sequential` when those modes are clearer than an options object. `describe.each`
and `describe.for` create parameterized suites.

## Assertions

`expect` is the primary assertion API. It supports common equality, identity,
truthiness, collection, exception, mock-call, asymmetric, soft, and promise
matchers. Asynchronous assertions must be awaited so the runner can observe
failures:

```ts
import { expect, test } from "@lightning-js/lightning";

test("checks an asynchronous result", async () => {
  await expect(Promise.resolve({ ok: true })).resolves.toEqual({ ok: true });
  await expect(Promise.reject(new Error("offline"))).rejects.toThrow("offline");
});
```

Use `expect.poll(callback, options)` to retry an asynchronous assertion until it
passes or reaches its deadline. The callback receives an `{ signal }` object;
respect its abort signal when doing cancellable work. Unawaited asynchronous
assertions fail the test.

## Mocks and spies

Import `vi`, `jest`, `fn`, `spyOn`, and `isMockFunction` from the package root.
`jest` is an alias for `vi`.

```ts
import { expect, fn, spyOn, vi } from "@lightning-js/lightning";

const send = fn((message: string) => `sent: ${message}`);
expect(send("hello")).toBe("sent: hello");
expect(send).toHaveBeenCalledWith("hello");

const service = { read: () => "original" };
const read = spyOn(service, "read").mockReturnValue("stubbed");
expect(service.read()).toBe("stubbed");
expect(read).toHaveBeenCalledOnce();
```

`vi` provides mock and spy utilities, basic fake timers, stubs, and factory module
mocks. Conditional mock behavior is available through
`vi.when(mock).calledWith(...).thenReturn(...)` and related return, resolve,
reject, throw, finite-action, disposal, and exhaustion APIs.

## Snapshots and test context

Use `toMatchSnapshot()` / `toMatchInlineSnapshot()` to assert snapshots. Run
`lightning run --update` to update mismatched snapshots. The callback context
provides a scoped `expect`, `task`, `onTestFinished`, and `onTestFailed`:

```ts
import { test } from "@lightning-js/lightning";

test("registers cleanup", async ({ expect, onTestFinished }) => {
  const resource = { closed: false };
  onTestFinished(() => { resource.closed = true; });
  expect(resource.closed).toBe(false);
});
```

## Browser helpers and type assertions

DOM helpers are a separate entry point. Import `render`, `cleanup`, and
`userEvent` from `@lightning-js/lightning/browser`; always await user interactions.
Type-only testing helpers `expectTypeOf` and `assertType` are exported from the
package root and are intended for declaration test files such as `*.test-d.ts`.
Those files are checked by TypeScript and are not executed as runtime tests.

## Public exports

| Entry point | Exports |
| --- | --- |
| `@lightning-js/lightning` | `test`, `it`, `describe`, lifecycle hooks, `expect`, `vi`, `jest`, `fn`, `spyOn`, `isMockFunction`, `onTestFinished`, `onTestFailed`, `bench`, `describeBench`, `expectTypeOf`, `assertType`, config helpers, and public types |
| `@lightning-js/lightning/config` | `defineConfig`, `defineProject`, `mapJestConfig`, and config types |
| `@lightning-js/lightning/browser` | Browser test APIs, `render`, `cleanup`, `userEvent`, and browser config helpers |
| `@lightning-js/lightning/globals` | Type declarations for APIs installed when `test.globals` is enabled |

Consult the [configuration guide](CONFIGURATION.md) for config shapes and CLI
overrides, and the [migration guide](MIGRATION.md) for deliberate compatibility
boundaries.
