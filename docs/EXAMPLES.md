# Examples cookbook

Small patterns for common Lightning test workflows. Install
`@lightning-js/lightning` as a development dependency and run examples with
`lightning run`.

## Test a promise

Await promise matchers so rejected assertions fail the current test:

```ts
import { expect, test } from "@lightning-js/lightning";

test("loads a profile", async () => {
  const profile = Promise.resolve({ id: 7, name: "Ada" });
  await expect(profile).resolves.toEqual({ id: 7, name: "Ada" });
});
```

## Table-driven tests

```ts
import { expect, test } from "@lightning-js/lightning";

test.each([
  [1, 2, 3],
  [5, 8, 13],
])("adds %i and %i", (left, right, expected) => {
  expect(left + right).toBe(expected);
});
```

Use `test.for` when you prefer a single tuple argument and test context:

```ts
import { test } from "@lightning-js/lightning";

test.for([[2, 3, 5], [7, 8, 15]] as const)(
  "sums %i and %i",
  ([left, right, expected], { expect }) => {
    expect(left + right).toBe(expected);
  },
);
```

## Register cleanup for a resource

```ts
import { expect, test } from "@lightning-js/lightning";

test("closes a resource after the test", async ({ onTestFinished }) => {
  const connection = await openConnection();
  onTestFinished(() => connection.close());
  expect(connection.isOpen()).toBe(true);
});
```

`onTestFinished` callbacks run after the test whether it passes or fails. Hook
functions can also return cleanup functions for setup scoped to a suite or each
test.

## Mock a function and inspect its calls

```ts
import { expect, fn, test } from "@lightning-js/lightning";

test("records calls", () => {
  const send = fn((message: string) => `sent: ${message}`);
  expect(send("ready")).toBe("sent: ready");
  expect(send).toHaveBeenCalledWith("ready");
});
```

## Select an environment for one file

Set the default environment in config, or add a directive at the top of a
single test file:

```ts
// @lightning-environment jsdom
import { expect, test } from "@lightning-js/lightning";

test("has a document", () => {
  expect(document.createElement("button").tagName).toBe("BUTTON");
});
```

Supported environments are `node`, `jsdom`, `happy-dom`, and `edge-runtime`.
Install the chosen DOM emulator in the consuming project.

## Type-only assertions

Place type assertions in `*.test-d.ts` or `*.spec-d.ts`; Lightning checks those
files with TypeScript but does not execute them:

```ts
import { assertType, expectTypeOf } from "@lightning-js/lightning";

const userId = 42;
expectTypeOf(userId).toEqualTypeOf<number>();
assertType<string>("Ada");
```

Run them with `lightning run --typecheck`. See the
[configuration guide](CONFIGURATION.md) for tsconfig selection and global types.

## Run tests in a real browser

Install Playwright and Chromium, then use the browser entry point for DOM
interactions:

```ts
import { render, userEvent } from "@lightning-js/lightning/browser";
import { expect, test } from "@lightning-js/lightning";

test("submits a form", async () => {
  const { container, unmount } = render('<button type="button">Save</button>');
  const button = container.querySelector("button");
  if (!button) throw new Error("button was not rendered");
  await userEvent.click(button);
  expect(button.textContent).toBe("Save");
  unmount();
});
```

Always await `userEvent` calls. Real-browser mode uses trusted Playwright input;
DOM emulators use synthetic events. See the
[configuration guide](CONFIGURATION.md#browser-mode) for browser setup.

## Add a benchmark

Benchmarks can be declared in `*.bench.ts` files and run with `lightning bench`:

```ts
import { expect, test } from "@lightning-js/lightning";

test("parse JSON", async ({ bench }) => {
  const result = await bench("JSON.parse", () => JSON.parse('{"ok":true}'), {
    time: 100,
  }).run();
  expect(result.throughput.mean).toBeGreaterThan(0);
});
```

Use `lightning bench --baseline artifacts/bench.json` to save a baseline and
`lightning bench --compare artifacts/bench.json --regression-threshold 10` to
fail on a throughput regression over 10 percent. Compare results on controlled
hardware.
