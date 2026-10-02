# Lightning 路线图与交付状态

> Lightning : Nasti = Vitest : Vite。复用 Nasti 的解析、转译和模块执行，
> Lightning 专注收集、调度、断言/Mock、环境、覆盖率和报告。
>
> 本轮对齐目标：**Vitest 5.0.3 的兼容核心与选定新 API**，不是完整复刻 Vitest。
> 下面的「完成」以实际交付和验收为准；兼容边界单独列出，不冒充已完成。

## 1. 已交付里程碑

| 阶段 | 状态 | 实际交付 |
| --- | --- | --- |
| Phase 0 — MVP | ✅ | CLI、配置、发现、Nasti SSR 收集/运行、退出码与默认报告 |
| Phase 1 — 执行引擎 | ✅ 核心 | threads/forks/inline、文件隔离、过滤、并发、超时、重试、重复 |
| Phase 2 — 断言/Mock/快照 | ✅ 核心 | Jest-style/asymmetric/custom/soft/promise matchers、spy/timer/stub、基础 factory mock、快照 |
| Phase 3 — Watch | ✅ | Node 依赖闭包重跑、传递缓存失效、终端交互；浏览器 watch 另走 client 管线 |
| Phase 4 — 生产周边 | ✅ | DOM/edge 环境、V8 与 Istanbul、标准报告、阈值、reporters、sharding、projects |
| Phase 5 — 浏览器模式 | ✅ Playwright | 浏览器矩阵、组件/DOM API、可信输入、依赖 watch、覆盖率 |
| Phase 6 — 生态与高级工具 | ✅ 兼容核心 | Jest/Vitest 迁移入口、类型测试、Tinybench、基线/回归门控、未捕获错误 |
| 武陵 DevOps | **延期** | 按项目决定，等待武陵重构；本轮不接接口、不设虚构端点 |

## 2. 本轮新增与债务清理

### Vitest 当前 API

- [x] `test(name, options, fn)`，保留旧签名。
- [x] `test.for` / `describe.for`、`skipIf` / `runIf`、`test.fails`。
- [x] 类型化 `TestContext`、`context.expect`、`onTestFinished` / `onTestFailed`。
- [x] 未等待的异步断言失败；`expect.poll` 的 AbortSignal 与悬挂回调超时。
- [x] `vi.when` 条件 Mock：FIFO 行为、LIFO action、有限次数、disposal、exhaustion。
- [x] `test.projects`、`maxWorkers`、`defineProject`、`--project`，保留旧配置别名。
- [x] projects 的内联、文件、目录、正 glob、嵌套及默认继承。
- [x] Vitest 5 风格的上下文 `bench` 子集；保留路线图原有顶层 bench API。

### 正确性债务

- [x] Node 并发测试使用 async-local 断言/快照状态，重试计数器按尝试隔离。
- [x] 浏览器异步作用域保持到尝试结束；缺少 async-local storage 时串行调度，
  不再让导入的 `expect` 在 `await` 后漏掉断言计数、soft failure 或异步断言。
- [x] beforeAll/beforeEach 失败后仍清理；返回的 hook cleanup、失败/结束回调可归因。
- [x] globals 按文件安装并恢复原 descriptor，不长期污染 inline/watch 宿主。
- [x] Runner deadline 使用原生时钟，不被测试的 fake timers 替换。
- [x] worker 提前退出即报失败，包括「退出码 0、但未报告结果」。
- [x] `.only` 静态扫描使用 AST，忽略注释/字符串并识别常用导入别名/选项。
- [x] `*.test-d.ts` / `*.spec-d.ts` 无论 runtime include 如何扩大都不执行。
- [x] 断言/条件 Mock 共用无环 equality 模块，避免 unbundled SSR 模块死锁。
- [x] 多项目只汇总一次 reporter；JSON 不再多文档拼接，JUnit 不再逐项目覆盖。
- [x] reporter 异常、无效 worker 数量与覆盖率阈值不能产生假成功。

## 3. Phase 4 验收与覆盖率设计

- [x] `node` / `jsdom` / `happy-dom` / `edge-runtime`，文件 docblock 覆盖。
- [x] React/jsdom、Vue/happy-dom 组件交互样例：`playground/frameworks`。
- [x] V8 捕获实际求值代码，恢复 OXC → module-runner → 原始 TS 映射，
  校验 AsyncFunction 包装行与 `"use strict";` 列偏移。
- [x] 内置导入兼容改写与 `import.meta.env` 替换的 source map 可组合恢复。
- [x] Istanbul 对原始 JS/TS/JSX 插桩，提供真实 AST 语句/分支计数。
- [x] 多文件覆盖率合并、include/exclude、未执行文件零覆盖、阈值门控。
- [x] text/html/lcov/json 使用 Istanbul 标准报告格式。
- [x] default/verbose/dot/json/junit/tap/github-actions、自定义对象/模块/class。
- [x] `outputFile`、标准 JUnit/XML 转义、JSON 安全序列化及错误退出码。
- [x] CLI sharding 回归验证：分片互斥且全集覆盖。

**语义边界**：V8 provider 使用 V8-to-Istanbul range 语义，不承诺等同于 AST
插桩。未知用户 transform map 链或 React compiler 输出会被校验拒绝，而不是
拿生成代码偏移假装原始 TS 覆盖率；需要插桩级指标时使用 Istanbul。

## 4. Phase 5 验收与执行模型

- [x] Playwright chromium/firefox/webkit 配置与可选 peer；浏览器二进制按需安装。
- [x] Nasti client ESM 管线；独立 runtime URL 保证 tester/spec 使用同一 collector。
- [x] HTTP POST 结果及快照回收，不假设 Nasti WS 支持双向 RPC。
- [x] `render` / `cleanup` / 异步 `userEvent`；真实浏览器走 Playwright 可信输入，
  DOM emulator 保留 synthetic fallback。
- [x] 实测可信 click 与真实 `:hover`。
- [x] Watch 保持 client server/依赖图，受影响文件打开新 page；执行期间变更排队。
- [x] SIGTERM/正常退出与不相关测试不重跑的真实浏览器回归。
- [x] Chromium V8 coverage；Istanbul 在浏览器收集原始插桩计数。

Firefox/WebKit 的 V8 coverage 明确拒绝；可使用 Istanbul。对应二进制未安装时，
不能把「有配置支持」冒充「本机已验证」。WebdriverIO 不在已交付 provider 中。

## 5. Phase 6 与跨阶段工程

- [x] `jest === vi`、globals、Jest 配置的明确子集映射；不支持字段报错。
- [x] Lightning 管线内的 Vitest/Jest 导入兼容、配置发现与迁移指南。
- [x] `expectTypeOf` / `assertType`，TypeScript-only 文件 runner 与精确诊断。
- [x] 类型测试的迁移导入路径及 globals declarations；IDE `./globals` 导出。
- [x] Tinybench 测量、统计、串行比较、JSON 基线与百分比吞吐回归门控。
- [x] 文件生命周期内的 uncaught exception / unhandled rejection 捕获与测试归因。
- [x] 自举、CLI/运行时/浏览器真实回归，Node/React/Vue/类型/基准 playground。
- [x] GitHub Actions：Node 22/24、threads/forks、playground、分片回归、Chromium。
- [x] `website/` 中英双语静态文档与 `pnpm docs` 本地预览。
- [x] `./config`、`./browser`、`./globals` 与 lazy `lightning()` 编程入口。
- [x] Nasti 2.5.2 / Rolldown 1.2.6 锁定；实验转译边界通过实测源码校验保护。

### 已做架构决议

- **命名**：保留 `vi`；`jest` 为兼容别名。`lightning()` 是编程入口，不创造
  一套不同于 Vitest 的测试 API 名称。
- **包结构**：继续单包 + subpath exports。没有独立发布/版本需求前不拆 monorepo，
  避免把版本协调成本引入测试内核。
- **执行**：默认 unbundled；不把 Nasti 的实验 bundled 模式冒充已稳定的测试 pool。
- **隔离**：默认 worker 文件隔离；inline / isolate:false 共享 native/module 状态，
  只保证框架自身状态清理，不声称 VM/process 隔离。

## 6. 后续兼容扩展（明确未完成）

这些不是本轮兼容核心的验收项，也不再藏在「Vitest/Jest compatible」口号后：

- [ ] 完整 Chai/Jest matcher 及完整自动 module mocking/ESM live bindings。
- [ ] 把基础 module-mock hoisting 的剩余字符串改写统一到 AST/source-map 管线。
- [ ] `test.extend` fixtures、around hooks、tags/annotations。
- [ ] Vitest 5 交错基准采样、专用比较 matcher、custom providers、from/writeResult。
- [ ] 多项目同时 watch、类型测试 watch、WebdriverIO、VM pools。
- [ ] 任意用户 transform 链的 V8 映射恢复、React compiler 完整映射。
- [ ] Trace view/UI/doctor/fs module cache；按实际需求评估，不与 Vitest 全量竞赛。
- [ ] 武陵集成：**延期**，等武陵重构后的协议和鉴权约定。

## 7. 复验命令

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:runtime
pnpm test:integration
pnpm test:browser:integration  # 需本机 Chromium
pnpm test:frameworks
pnpm test:types
pnpm test:bench
pnpm docs
```
