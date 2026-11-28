---
name: lightning
description: Write, run, configure, and debug tests with the @lightning-js/lightning testing framework. Use for Lightning unit, DOM, browser, and type tests, mocks, snapshots, coverage, benchmarks, or migration from Vitest or Jest to Lightning.
---

# Lightning testing

## Start with the project's test setup

1. Check `package.json`, the Lightning config, and nearby tests. Follow the
   project's scripts, file naming, and workspace layout. Do not replace an
   existing test runner unless asked to migrate.
2. For a new pnpm setup, use Node.js 22.12.0 or newer and run
   `pnpm add -D @lightning-js/lightning` in the package that owns the tests.
   Use explicit imports unless `test.globals` is already enabled.
3. Run the affected file first, then the relevant project or full suite.
   Use `run` for a one-shot check and `watch` for interactive development.

```sh
pnpm exec lightning run test/cart.test.ts
pnpm exec lightning run test/cart.test.ts -t "adds items"
pnpm exec lightning run --project unit
pnpm exec lightning run
pnpm exec lightning watch
```

Positional filters match substrings of test file paths; `-t` matches test names
with a regular expression. Use `--project` only for a configured project.
If nothing runs, check the command's working directory, the project's
`test.include` / `test.exclude` globs, and the filters before changing the test.

## Write a test

Use `*.test.ts` or `*.spec.ts` unless the project config says otherwise. Use
`test.for` when you want each row as one argument plus the test context;
`test.each` spreads the row into positional arguments.

```ts
// test/cart.test.ts
import { expect, test, vi } from "@lightning-js/lightning";

test.for([[2, 3, 5], [0, 4, 4]] as const)(
  "adds items: %i + %i",
  ([initial, added, total], { expect }) => {
    expect(initial + added).toBe(total);
  },
);

test("loads the saved cart", async () => {
  const load = vi.fn(async (_id: string) => ({ items: 2 }));
  await expect(load("cart-1")).resolves.toEqual({ items: 2 });
  expect(load).toHaveBeenCalledWith("cart-1");
});
```

Await `.resolves`, `.rejects`, `expect.poll`, and browser interactions.
Use `vi.spyOn` for existing methods and restore spies after the test.
Review snapshot diffs; run `pnpm exec lightning run test/cart.test.ts --update`
only when the new output is intentional.

## Configure the environment

Use the default `node` environment unless the test needs DOM APIs. Install
`jsdom` or `happy-dom` separately for emulation and set `test.environment`,
or put `// @lightning-environment jsdom` at the top of a single file.

```ts
// lightning.config.ts
import { defineConfig } from "@lightning-js/lightning/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
```

Use `test.projects` for suites with different globs or environments. When tests
need real layout or browser input, install `playwright` as a dev dependency,
run `pnpm exec playwright install chromium`, then
`pnpm exec lightning run --browser --browser-name chromium`. Import `render`,
`cleanup`, and `userEvent` from `@lightning-js/lightning/browser` and await
`userEvent` calls.

## Other workflows

- **Type tests:** Put `expectTypeOf` or `assertType` in `*.test-d.ts` or
  `*.spec-d.ts` and run `pnpm exec lightning run --typecheck`. These files
  are checked by TypeScript, not executed.
- **Coverage:** Run `pnpm exec lightning run --coverage`. Use
  `--coverage-provider istanbul` for instrumentation-based coverage or when
  running browser coverage outside Chromium.
- **Benchmarks:** Put them in `*.bench.ts`, use the test context's `bench`,
  and run `pnpm exec lightning bench`.
- **Vitest/Jest migration:** Lightning supports a subset, not a drop-in
  replacement. Prefer explicit Lightning imports for migrated tests. Do not
  assume Vitest fixtures or full Jest automocking work; check the migration guide.

## Look up APIs with Context7

Use the [Lightning index on Context7](https://context7.com/zixiao-labs/lightning)
with library ID `/zixiao-labs/lightning`. Query the specific workflow, for
example: “How do I define separate Node and jsdom projects and run just one?”
Check the installed version with `pnpm exec lightning --version`; confirm flags
with `pnpm exec lightning run --help` rather than assuming the index matches
the installed release.

If Context7 is unavailable, browse the
[documentation on GitHub](https://github.com/zixiao-labs/Lightning/tree/main/docs).
To find docs for a specific installed version, switch to its release tag
(`v<version>`) and open the `docs/` directory there.
