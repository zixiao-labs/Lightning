# Configuration guide

Lightning configuration is a JavaScript or TypeScript module that exports a
config object. Import `defineConfig` and `defineProject` from
`@lightning-js/lightning/config` for editor inference. Node.js 22.12.0 or newer
is required.

## Basic test configuration

```ts
import { defineConfig } from "@lightning-js/lightning/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/fixtures/**"],
    environment: "node",
    testTimeout: 5_000,
    maxWorkers: 4,
    reporters: ["default"],
  },
});
```

`test.include` and `test.exclude` are test-file globs. The default environment is
`node`; other supported values are `jsdom`, `happy-dom`, and `edge-runtime`.
`maxWorkers` controls how many test files execute concurrently. The default pool
is `threads`; `forks` and `inline` are also supported. `isolate: false` selects
shared inline execution, which shares imported module state and cannot forcibly
interrupt a synchronous infinite loop.

The config can also set `globals`, `retry`, `repeats`, `update`,
`snapshotDir`, `testNamePattern`, `pool`, `poolOptions.maxWorkers`, and
`reporters`. Global test APIs are disabled by default. Prefer explicit imports
unless a project intentionally uses `globals: true`.

## Projects

Use projects when one invocation needs multiple test suites or environments:

```ts
import { defineConfig, defineProject } from "@lightning-js/lightning/config";

export default defineConfig({
  test: {
    maxWorkers: 3,
    projects: [
      defineProject({
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
        },
      }),
      {
        test: {
          name: "dom",
          include: ["test/dom/**/*.test.ts"],
          environment: "jsdom",
        },
      },
      "packages/*/lightning.config.ts",
    ],
  },
});
```

Projects may be inline config objects, config-file paths, directories, or
positive glob patterns. Inline project defaults inherit from the root; set
`extends: false` to opt out. Referenced configs may contain nested projects.
Select a project with `lightning run --project unit` (or `-p unit`); parent
names select nested children. Watch one project at a time. Root reporters run
once for the full invocation and aggregate project results.

## Browser mode

Install Playwright and a browser binary, then opt in with CLI or config:

```ts
import { defineConfig } from "@lightning-js/lightning/config";

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      provider: "playwright",
      browsers: ["chromium"],
      headless: true,
    },
  },
});
```

`browser.browsers` accepts `chromium`, `firefox`, and `webkit`; browser binaries
must be installed. `--browser` enables browser mode for a run, and
`--browser-name` selects a browser. Browser test attempts run serially. Import
DOM helpers from `@lightning-js/lightning/browser` and await each `userEvent`
interaction.

## Coverage

Coverage can be enabled with `--coverage` or config:

```ts
import { defineConfig } from "@lightning-js/lightning/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      provider: "istanbul",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "artifacts/coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts"],
      thresholds: { lines: 80, functions: 80, branches: 70 },
    },
  },
});
```

Providers are `v8` and `istanbul`. V8 maps evaluated JavaScript ranges and its
metrics are not identical to AST instrumentation. Istanbul instruments original
JS/TS/JSX source. Browser V8 coverage requires Chromium; use Istanbul for
Firefox/WebKit or when instrumentation-level metrics are required. Threshold
failures return a non-zero exit status.

## Type tests and reports

Declaration files matching `*.test-d.ts` and `*.spec-d.ts` run through TypeScript
only, never as runtime tests. Configure `test.typecheck.tsconfig` or pass
`--tsconfig`. For editor types with globals, include
`@lightning-js/lightning/globals` in `compilerOptions.types`.

Built-in test reporters are `default`, `verbose`, `dot`, `json`, `junit`, `tap`,
and `github-actions`. Configure output with `test.outputFile` or
`--output-file`; output paths can be set per reporter. For multiple projects,
configure reporters and output paths at the root so one report contains all
project results.

## Command-line overrides

```sh
lightning run --project unit
lightning run --coverage --coverage-provider v8
lightning run --reporter junit --output-file artifacts/junit.xml
lightning run --shard 1/4
lightning run --typecheck --tsconfig tsconfig.tests.json
lightning run --update
```

CLI flags select or override runtime behavior for a particular invocation.
Use `lightning run --help` for the installed CLI's available options.

## Configuration discovery and compatibility

Lightning config files take precedence. If none exists, Lightning can discover
`vitest.config.{ts,mts,js,mjs}` and Jest config files. Export a config object (or
a promise for one), not a config factory function. Legacy top-level `projects`
and `poolOptions.maxWorkers` remain accepted aliases. Jest configuration maps
only documented fields; unsupported Jest options fail explicitly. See
[Migration / 迁移指南](MIGRATION.md) for the full supported subset.
