# Migration / 迁移指南

For the public exports and runnable usage patterns, see the [API reference](API.md),
[configuration guide](CONFIGURATION.md), and [examples cookbook](EXAMPLES.md).

## From Vitest

1. Install `@lightning-js/lightning` and change the test script to `lightning run`.
2. Prefer explicit imports from `@lightning-js/lightning` and configuration helpers
   from `@lightning-js/lightning/config`.
3. Lightning's module pipeline rewrites `vitest`, `vitest/config`, `@jest/globals`
   and supported browser-context imports. This applies to Lightning-run modules;
   it is **not** a process-wide alias for unrelated native Node imports.
4. `vitest.config.{ts,mts,js,mjs}` is discovered when no Lightning config exists.
   Export a config object (or a promise of one), not a config factory function.
5. Use `test.projects`, `test.maxWorkers`, `defineProject` and `--project`.
   Legacy Lightning fields remain aliases. Only positive project glob patterns and
   boolean `extends` are supported.
6. Always await `.resolves`, `.rejects`, `expect.poll` and browser `userEvent`.
7. Browser test attempts are serial; Node threads/forks support concurrency.
8. Use `context.bench` for new benchmarks. `bench.compare` is serial, and CLI
   baselines use Lightning's versioned JSON format.

Type tests map Vitest import paths to Lightning declarations automatically.
For normal editor checking, update imports or add explicit TypeScript `paths`.
For globals, include `@lightning-js/lightning/globals` in `compilerOptions.types`.

### Deliberate compatibility boundaries

Lightning does not claim full Chai/Vitest/Jest compatibility. Currently unsupported:

- `test.extend` fixtures, `aroundEach` / `aroundAll`, tags and annotations.
- Vitest UI, trace view, `doctor`, VM pools and file-system module caches.
- Vitest's full benchmark comparison matcher/provider/from/writeResult APIs.
- Complete Jest config mapping, Jest custom transformers and full automocking.
- Complete ESM live-binding-preserving module-mock transformation. Current
  hoisting/factory mocks target the core supported test-file patterns.
- Watch of multiple projects at once, type-test watch, WebdriverIO.
- V8 remapping through arbitrary user transform chains or React compiler output.
  The runner detects mismatches; Istanbul is the supported alternative for
  instrumentation-level metrics.

Watch currently uses the terminal reporter. Use one-shot runs for machine-readable
CI reports. Inline/shared execution cannot forcibly interrupt synchronous infinite
loops or provide process-level isolation.

## From Jest

`jest` is an alias of `vi`, including globals mode and `@jest/globals` imports.
When no Lightning/Vitest config exists, Lightning discovers Jest config files.

Supported mapping:

| Jest option | Lightning |
| --- | --- |
| `rootDir` | `root` |
| `testMatch` | `test.include` (`<rootDir>/` prefix removed) |
| `testEnvironment` | `test.environment` |
| `testTimeout` | `test.testTimeout` |
| `injectGlobals` | `test.globals` (Jest default: true) |
| integer `maxWorkers` | `test.maxWorkers` |
| `collectCoverage` | `test.coverage.enabled` |
| `collectCoverageFrom` | `test.coverage.include` |
| `coverageDirectory` | `test.coverage.reportsDirectory` |

Unsupported Jest options fail explicitly, rather than being ignored.
`mapJestConfig` can also be called from a Lightning config. Remove conflicting
`@types/jest` ambient declarations when using Lightning's globals types.

## 中文

- 优先把测试导入改为 `@lightning-js/lightning`，配置导入改为
  `@lightning-js/lightning/config`；命令改为 `lightning run`。
- Lightning 管线提供 Vitest/Jest 导入兼容，不会修改整个 Node 进程的模块解析。
  支持迁移后的 `vitest.config`、`defineProject`、内联/路径/glob/嵌套 projects、
  `maxWorkers`；配置工厂函数、负 glob 和字符串 `extends` 不在支持范围内。
- `jest` 与 `vi` 是同一对象。Jest 配置仅映射上表中的字段，其余字段明确报错。
- 所有异步断言和浏览器交互都必须 `await`。浏览器没有 async-local storage，
  因此测试尝试串行执行，避免断言计数或快照串台。
- `*.test-d.ts` / `*.spec-d.ts` 只做 TypeScript 检查，不执行；
  `globals: true` 的编辑器类型来自 `@lightning-js/lightning/globals`。
- V8 报告使用 V8 range → Istanbul 的语义，不能等同于 AST 插桩指标；
  需要语句/分支插桩或覆盖率管线含特殊转换时使用 `istanbul`。
- 基准测试支持上下文 `bench`、串行比较、CLI 基线及回归门控，不宣称完整实现
  Vitest 5 的交错采样、专用比较 matcher 或自定义 provider。
- 上面的兼容边界是明确的后续事项，不是已完成特性。武陵集成按项目决定延期。
