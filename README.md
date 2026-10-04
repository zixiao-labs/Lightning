# Lightning ⚡️

A Nasti-native testing framework for Node.js, DOM emulators and real browsers.
Lightning reuses Nasti's TypeScript/JSX, ESM and module pipeline; Playwright powers
its optional browser mode.

**Requires Node.js >=22.12.0.** The compatibility target is Vitest **5.0.3**.
This is a supported API subset, not an implementation of every Vitest/Jest feature.
See [migration and compatibility](docs/MIGRATION.md), [路线图](ROADMAP.md), and the
[English / 中文 documentation site](website/index.html).
See also the [API reference](docs/API.md), [configuration guide](docs/CONFIGURATION.md),
and [examples cookbook](docs/EXAMPLES.md).

## Quick start

```sh
pnpm add -D @lightning-js/lightning
pnpm exec lightning run
pnpm exec lightning watch
```

```ts
import { test, expect } from "@lightning-js/lightning";

test("adds numbers", () => {
  expect(1 + 2).toBe(3);
});

test.for([[1, 2, 3], [2, 3, 5]] as const)("sum %i + %i", ([a, b, sum], { expect }) => {
  expect(a + b).toBe(sum);
});
```

Bare `lightning` watches in an interactive terminal and runs once in CI/non-TTY.
Use `run`, `watch`, `--watch` or `--no-watch` to choose explicitly.

## Configuration and projects

```ts
import { defineConfig } from "@lightning-js/lightning/config";

export default defineConfig({
  test: {
    maxWorkers: 2,
    projects: [
      { test: { name: "unit", include: ["test/unit/**/*.test.ts"] } },
      { test: { name: "dom", environment: "jsdom", include: ["test/dom/**/*.test.ts"] } },
      "packages/*/lightning.config.ts",
    ],
  },
});
```

Projects accept inline objects, config files, directories and positive glob
patterns. Defaults are inherited; `extends: false` opts out. Referenced configs can
contain nested projects. `--project unit` / `-p unit` selects a project; parent
names select nested children. Legacy top-level `projects` and
`poolOptions.maxWorkers` remain accepted.

Reporters run once for the whole invocation, so multi-project JSON is one valid
document and JUnit contains all project results. Configure reporters/output paths
at the root. Coverage reports remain project-root-relative. Benchmark comparison
and baseline output paths use the root config's `root`; one baseline contains
results from all projects.
Watch one project at a time with `--project`.
The default reporter's `Duration` line includes transform, setup, import, test and
environment timings. These are accumulated phase measurements, not a wall-time
partition, so they can exceed the total when work overlaps or runs concurrently.

## Runtime

- `test` / `it`, `describe`, hooks, `.each`, `.for`, `.skip`, `.only`, `.todo`,
  `.skipIf`, `.runIf`, `.fails`, `.concurrent`, `.sequential`, timeout/retry/repeats.
- Both `test(name, fn, timeout)` and `test(name, options, fn)` are supported.
- Test context provides `expect`, `task`, `onTestFinished` and `onTestFailed`.
  Hook-returned cleanup functions also run after failures.
- Node concurrent tests use async-local assertion and snapshot state.
  Browsers run test attempts serially because they lack async-local storage.
- Unawaited asynchronous assertions fail the test. `expect.poll` receives
  `{ signal }` and aborts hanging callbacks at its deadline.
- File-scoped capture reports unhandled rejections and uncaught exceptions.
- Pools: `threads` (default), `forks`, `inline`. `isolate: false` uses the
  shared inline runner and deliberately shares imported module state.
- Core Jest-style, asymmetric, soft, custom and promise matchers; snapshots with
  `--update`; `vi.fn`, spies, basic fake timers, stubs and factory module mocks.
- Vitest 5 conditional mocks: `vi.when(mock).calledWith(...).thenReturn(...)`,
  promise/throw actions, finite actions, disposal, and `toHaveBeenExhausted`.

With `globals: true`, APIs are installed for a file and previous descriptors are
restored afterwards. For editor type support:

```json
{ "compilerOptions": { "types": ["node", "@lightning-js/lightning/globals"] } }
```

## Environments and browser mode

Install DOM environments only when needed:

```sh
pnpm add -D jsdom
# or: pnpm add -D happy-dom
pnpm add -D playwright
pnpm exec playwright install chromium
pnpm exec lightning run --browser
pnpm exec lightning watch --browser
```

Set `test.environment` to `node`, `jsdom`, `happy-dom` or `edge-runtime`.
`// @lightning-environment jsdom` overrides the environment for one file.

Browser config uses `test.browser: { enabled: true, browsers: ["chromium"],
headless: true }`. Chromium, Firefox and WebKit can be selected with
`--browser-name`; corresponding browser binaries must be installed.

`render`, `cleanup` and asynchronous `userEvent` come from
`@lightning-js/lightning/browser`. **Always await interactions.** Browser mode
uses trusted Playwright input, including real `:hover`; DOM emulators use a
synthetic-event fallback. Browser watch reruns affected dependencies in fresh pages
and queues changes that arrive during a run.

See `playground/browser` and `playground/frameworks` for vanilla, React/jsdom and
Vue/happy-dom examples.

## Coverage and CI reports

```sh
pnpm exec lightning run --coverage --coverage-provider v8
pnpm exec lightning run --coverage --coverage-provider istanbul
pnpm exec lightning run --reporter junit --output-file artifacts/junit.xml
pnpm exec lightning run --reporter json --output-file artifacts/results.json
pnpm exec lightning run --shard 1/4
```

Configure `test.coverage` with `include`, `exclude`, `reporter`,
`reportsDirectory` and `thresholds` (`lines`, `functions`, `branches`,
`statements`). Reporters support `text`, `html`, `lcov` and standard Istanbul
`coverage-final.json`; unexecuted included files receive zero hits.

- **V8:** captures evaluated JavaScript, validates/restores Nasti source maps and
  merges V8 ranges. Its metrics have V8-to-Istanbul semantics, not instrumented
  AST-level equivalence. Unknown transform map chains fail instead of reporting
  generated offsets against original TypeScript.
- **Istanbul:** instruments original JS/TS/JSX for AST statement/branch counters,
  including browser mode. Prefer it when instrumentation-level metrics are needed.
- Browser V8 coverage requires **Chromium**. Firefox/WebKit reject V8 coverage
  explicitly; use Istanbul instead.
- Coverage thresholds and reporter failures produce a non-zero exit status.

Test reporters: `default`, `verbose`, `dot`, `json`, `junit`, `tap`,
`github-actions`, or a custom object/module. `outputFile` accepts a path or a
per-reporter path map.

## Type tests

```sh
pnpm exec lightning run --typecheck
```

```ts
// value.test-d.ts
import { expectTypeOf, assertType } from "@lightning-js/lightning";

expectTypeOf<number>().toEqualTypeOf<number>();
assertType<string>("hello");
```

`*.test-d.ts` and `*.spec-d.ts` run through TypeScript **only**. Runtime discovery
rejects these files even with broad include globs. `test.typecheck.tsconfig` or
`--tsconfig` selects the config. Diagnostics retain file, line, column and TS code.
Migrated `vitest` imports are mapped to Lightning declarations; explicit user
`paths` take precedence. Type tests are currently run-only.

## Benchmarks

```ts
// parse.bench.ts — Vitest 5-style context API
import { test } from "@lightning-js/lightning";

test("JSON parsing", { timeout: 10_000 }, async ({ bench, expect }) => {
  const result = await bench("parse", () => JSON.parse("{}"), { time: 100 }).run();
  expect(result.throughput.mean).toBeGreaterThan(0);
});
```

`bench.compare(...)` returns a map of Tinybench results. Legacy top-level `bench`,
`.skip`, `.only` and `describe.bench` remain supported.

```sh
pnpm exec lightning bench --baseline artifacts/bench.json
pnpm exec lightning bench --compare artifacts/bench.json --regression-threshold 10
```

Measurements are serial. A throughput loss exceeding the threshold fails the run.
Compare on controlled hardware; normal timing noise is not a correctness guarantee.
This is not Vitest 5's full interleaved/custom-provider benchmark implementation.

## Releases

See the [v3.0.0 Release Notes](https://github.com/zixiao-labs/Lightning/blob/v3.0.0/docs/releases/v3.0.0.md)
for changes and upgrade instructions, or browse [all releases](https://github.com/zixiao-labs/Lightning/releases).

## Development

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:runtime
pnpm test:integration
pnpm test:browser:integration   # requires installed Chromium
pnpm test:frameworks
pnpm test:types
pnpm test:bench
pnpm docs
```

Wuling DevOps integration is **postponed by project decision** while Wuling is
being rebuilt. No placeholder network endpoint or credential handling is shipped.
