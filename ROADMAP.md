# Lightning 路线图

> 目标：构建一个**架构对齐 Vitest、内核复用 Nasti 2.0** 的下一代测试框架。
> 类比关系：**Lightning : Nasti ＝ Vitest : Vite**。
>
> Lightning 不重写转译/解析/HMR——这些 Nasti 2.0 已用 Rolldown + OXC 做到生产级。
> Lightning 专注测试层：**收集 → 调度 → 执行 → 断言/Mock → 报告**。

---

## 0. 背景与核心洞察

### 0.1 现状
- Lightning 当前为空壳：`@lightning-js/lightning@0.0.0-reserved`，仅 `README.md`（特性愿景）+ `tsdown` 构建脚手架 + 依赖 `@nasti-toolchain/nasti`。
- README 已锁定特性面：Vitest/Jest 兼容、watch（test 版 HMR）、TS/JSX 开箱、ESM-first/TLA、Tinybench 基准、并发/超时/projects、快照、v8 覆盖率、重试/隔离、happy-dom/jsdom、expect-type 类型测试、sharding、Playwright 浏览器模式、武陵 DevOps 集成（planned）。

### 0.2 🔑 战略洞察：Nasti 2.0 已铺好测试框架的两块地基
Nasti 2.0 为下游测试框架预留了精确的接缝（见 `NASTI_2.0_PLAN.md` 开篇与 §2.4）：

| Nasti 2.0 能力 | 导出 | Lightning 用途 | Vitest 对应 |
|---|---|---|---|
| **Module Runner**（SSR dev 执行） | `NastiModuleRunner`（`server/runnable-environment.ts`） | **执行测试文件的核心原语**：resolve→load→transform→`moduleRunnerTransform`→求值，TS/JSX/TLA 开箱 | `ssrLoadModule` / Vite module-runner |
| **Environment API** | `NastiEnvironment` / `resolveEnvironmentPlugins` | 新增专用 `test` 环境（`consumer:'server'`），独立 moduleGraph + pluginContainer | Vitest 的 `test` environment |
| **RPC 桥契约** | `HotChannel.invoke` / `fetchModule` / `createNoopHotChannel` | worker ↔ 主进程通信（拉模块、回传结果），契约已"一次定全" | Vitest worker RPC |
| **配置系统** | `resolveConfig` / `defineConfig` / `loadEnv` | `lightning.config.ts` 归并进 Nasti 配置，复用 transformers/resolvers/plugins | Vite `resolveConfig` |
| **日志/调试** | `createLogger` / `createDebugger` / `printServerUrls` | 测试输出、`lightning:*` debug 命名空间 | Vite logger |
| **模块图** | `ModuleGraph`（per-env） | watch 模式下「改了 X → 哪些测试受影响」的依赖反查 | Vitest `getModulesByFile` |

> 关键结论：Vitest 80% 的复杂度在 transform/resolve/HMR/module-runner。**这部分 Lightning 直接消费 Nasti**，省下绝大部分工作，集中火力在测试运行时本身。

### 0.3 关键约束（继承自 Nasti 2.0）
1. **Module Runner 走 `__vite_ssr_import__` / `__vite_ssr_exports__` 约定**（与 Vite module runner 同构，见 `runnable-environment.ts` 头注）。Lightning 的全局注入（`test`/`expect`/`vi`）必须在 runner 求值上下文里挂载，而非污染真实 `globalThis`（隔离前提）。
2. **`dev`/`DevEngine` 等 rolldown/experimental 实验性、未版本化**：完整打包模式相关能力 opt-in + 守卫导入 + 锁版本。Lightning 默认走 unbundled module runner（与 Vitest 默认一致），不依赖完整打包模式。
3. **CSS 永远留在 JS 层**（rolldown#4271）：测试里 import CSS 走 Nasti 的 `moduleType:'js'` 管线，DOM 环境下注入 `<style>`，node 环境下转 no-op/CSS Modules proxy。

---

## 1. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│  CLI  (lightning run | watch | bench | --coverage | ...)      │
├─────────────────────────────────────────────────────────────┤
│  Config        lightning.config.ts → resolveConfig(Nasti)     │
│                + test 专属字段（include/pool/environment/...） │
├─────────────────────────────────────────────────────────────┤
│  Orchestrator (主进程)                                         │
│   ├─ 测试文件发现 (glob include/exclude)                       │
│   ├─ Nasti createServer + 新增 `test` Environment             │
│   ├─ Pool 管理 (worker_threads / forks / vmThreads)           │
│   ├─ RPC 服务端 (fetchModule 经 test 环境管线)                │
│   ├─ ModuleGraph 反查 → watch 受影响重跑                       │
│   └─ Reporter 汇聚                                             │
├─────────────────────────────────────────────────────────────┤
│  Worker (每个隔离单元)                                         │
│   ├─ NastiModuleRunner (拉取/求值测试模块)                     │
│   ├─ Runtime: 全局注入 test/describe/expect/vi/beforeEach...  │
│   ├─ Collector: 构建 suite/task 树                            │
│   ├─ Runner: 调度 task（并发/串行/超时/重试/钩子）            │
│   ├─ Environment: node | happy-dom | jsdom | edge             │
│   └─ 结果经 RPC 流式回传                                       │
└─────────────────────────────────────────────────────────────┘
```

**包结构（建议 monorepo，对齐 Vitest）**：
- `@lightning-js/lightning` — 主包（CLI + orchestrator + runtime 入口）
- `@lightning-js/expect` — 断言库（chai 内核 + jest 兼容 matchers）
- `@lightning-js/spy` — `vi.fn`/`vi.spyOn`（可借 tinyspy）
- `@lightning-js/runner` — 收集器 + task 调度器（可独立复用）
- `@lightning-js/snapshot` — 快照引擎
- `@lightning-js/browser` — Playwright 浏览器模式（后期）

> MVP 阶段可先单包，Phase 2 后再按需拆分。

---

## 2. 分阶段计划

> 每阶段含：目标 / 关键设计 / 交付物 / 验收标准。顺序即落地优先级。

### Phase 0 — MVP：能跑起来 ⚡

**目标**：`npx lightning run` 能发现 `*.test.ts`、串行执行、输出 pass/fail/错误栈。打通「Nasti module runner → 测试运行时」全链路。

**关键设计**：
- **配置**：`defineConfig`（Lightning 版）→ 内部调 Nasti `resolveConfig`，注入一个 `test` environment（`consumer:'server'`，复用 client 的 transformers/resolvers/plugins）。新增 `test.{include,exclude,globals,environment,root}` 字段。
- **文件发现**：glob 默认 `**/*.{test,spec}.{js,ts,jsx,tsx}`，排除 `node_modules`/`dist`。
- **运行时（globals）**：`test`/`it`/`describe`/`expect`/`beforeEach`/`afterEach`/`beforeAll`/`afterAll`，先挂在 runner 求值上下文。`test.skip`/`.only`/`.todo`/`.each`。
- **收集 + 执行**：先**单进程串行**（in-process `NastiModuleRunner`，不开 worker），快速验证链路。Collector 建 suite 树 → Runner 深度遍历执行。
- **最小 expect**：`toBe`/`toEqual`/`toBeTruthy`/`toThrow`/`.not`（Phase 2 补全）。
- **Reporter**：默认 reporter（spec 风格：✓/✗ + 摘要 + 失败 diff/栈）。

**交付物**：`src/cli.ts`、`src/config/`、`src/node/orchestrator.ts`、`src/runtime/{collect,run,globals}.ts`、`src/expect/`（最小）、`src/reporters/default.ts`。

**验收**：示例项目里写 3 个测试（含 1 个故意失败），`lightning run` 正确输出、退出码正确（失败非 0）。

---

### Phase 1 — 执行引擎：Pool 与隔离

**目标**：worker 池并行执行，测试文件级隔离，超时/重试/并发。

**关键设计**：
- **Pool**：`worker_threads` 池（默认）+ `forks`（child_process，调试/原生模块友好）。池大小默认 `cpus-1`，可配 `poolOptions`。
- **隔离**：每个测试文件在独立隔离单元执行（`isolate:true` 默认）；`test` 环境的 module-runner 缓存按 worker 隔离。提供 `isolate:false` 快速模式（共享 runner，仅清缓存）。
- **RPC 桥**：worker 内 runner 的 `fetchModule` 回调 → 经 `HotChannel.invoke` 契约 → 主进程的 `test` 环境管线（resolve→load→transform→runnerTransform）→ 回传代码。**这是 Nasti 2.0 §2.4 已定型的契约，直接复用**。
- **调度**：suite/test 级 `concurrent`、`sequential`、`timeout`、`retry`、`repeats`；钩子（before/after）正确嵌套与失败传播。
- **filter**：`-t/--testNamePattern`、按文件名过滤、`.only` 全局收敛。

**交付物**：`src/node/pool.ts`、`src/node/rpc.ts`、`src/runtime/worker.ts`、调度器 `src/runner/`。

**验收**：并行跑 100+ 测试文件，隔离正确（全局态不串台），超时/重试生效，耗时显著低于串行。

---

### Phase 2 — 断言、Mock、快照（Jest/Vitest 兼容核心）

**目标**：完整断言 + mock 生态，达到能迁移真实 Jest/Vitest 用例的程度。

**关键设计**：
- **expect**：chai 内核 + jest 兼容 matchers 全集（`toMatchObject`/`toHaveBeenCalledWith`/`toContain`/`toThrowError`/asymmetric matchers `expect.any`/`objectContaining`/...）。`expect.extend` 自定义 matcher。soft assertions、`expect.poll`/`expect.assertions`。
- **vi 命名空间**：
  - `vi.fn`/`vi.spyOn`/`vi.mocked`（spy 引擎，参考 tinyspy）。
  - `vi.useFakeTimers`/`advanceTimersByTime`/`setSystemTime`（假时钟）。
  - `vi.stubGlobal`/`vi.stubEnv`。
- **模块 Mock**（最具挑战）：`vi.mock(path, factory)`/`vi.doMock`/`vi.importActual`/自动 mock。实现路径：在 `test` 环境**注入一个 Lightning resolver/transform 插件**拦截被 mock 的模块 id，runner 求值前替换。提升（hoist）`vi.mock` 到文件顶部——经 OXC 静态分析改写（复用 Nasti transform 钩子）。
- **快照**：`toMatchSnapshot`/`toMatchInlineSnapshot`/file snapshot；序列化器可扩展；`--update`/`-u`；obsolete 快照检测。

**交付物**：`src/expect/`（全集）、`src/mock/`、`src/snapshot/`、`vi` 运行时。

**验收**：迁移一组 Vitest 官方示例用例（mock + snapshot + matchers）全绿。

---

### Phase 3 — Watch 模式（测试版 HMR）

**目标**：`lightning watch`（或 `lightning` 默认）—— 改一个源文件，只重跑受影响的测试。

**关键设计**：
- 复用 Nasti `test` 环境的 **`ModuleGraph` 做反向依赖追踪**：文件变更 → 查 importers 闭包 → 命中的测试文件集合 → 仅重跑这些。
- 复用 Nasti `chokidar` watcher + HMR 通道；测试侧不做模块级 HMR（重跑文件即可），但保留转译缓存（未变模块不重转）。
- 交互式终端：`a` 全跑 / `f` 仅失败 / `t` 按名过滤 / `p` 按文件 / `q` 退出（参考 Vitest）。
- 与 Phase 1 pool 协作：watch 下保持 worker 常驻，重跑复用。

**交付物**：`src/node/watch.ts`、终端交互层。

**验收**：大型项目改一个 util，1s 内只重跑依赖它的测试。

---

### Phase 4 — 环境、覆盖率、报告、Sharding

**目标**：补齐生产可用的周边。

**关键设计**：
- **DOM 环境**：`environment: 'happy-dom' | 'jsdom' | 'node' | 'edge-runtime'`。环境为可选依赖，在 worker 求值前 setup/teardown，注入 `window`/`document`。`// @lightning-environment jsdom` 文件级 docblock 覆盖。
- **覆盖率**：v8 coverage（默认，`v8-to-istanbul`）+ 可选 istanbul provider。reporters：text/html/lcov/json。阈值门控（`coverage.thresholds`）。
- **Reporters**：default/dot/json/junit/tap/github-actions/verbose；自定义 reporter 接口。
- **Sharding**：`--shard=1/4`，配合 CI 拆分。
- **projects**：单仓多配置（不同环境/glob）一次跑完（对齐 Vitest workspace/projects）。

**交付物**：`src/environments/`、`src/coverage/`、`src/reporters/*`、`src/node/sharding.ts`。

**验收**：React 组件测试（jsdom）跑通 + 覆盖率 HTML 报告生成 + JUnit XML 可被 CI 消费。

---

### Phase 5 — 浏览器模式（Playwright）

**目标**：在真实浏览器中跑测试/组件测试（README 的「built on Playwright」愿景）。

**关键设计**：
- `@lightning-js/browser`：Playwright 驱动，Nasti `createServer` 提供页面与模块（client 环境，真实浏览器执行而非 module runner）。
- 测试代码与断言经 Nasti dev server 注入浏览器；结果经 ws 回传（复用 Nasti `createWsHotChannel`）。
- `browser.provider: 'playwright' | 'webdriverio'`，`headless`、多浏览器矩阵（chromium/firefox/webkit）。
- 组件测试 API（`render`）+ 与 Testing Library 协作。

**交付物**：`@lightning-js/browser`、浏览器 runtime bridge。

**验收**：在 chromium headless 跑组件测试，含真实 DOM 交互断言。

---

### Phase 6 — 生态兼容与高级特性

**目标**：迁移成本趋近于零 + 差异化能力。

**关键设计**：
- **Jest 兼容层**：`jest.fn`→`vi.fn` 别名、`jest.config` 部分映射、globals 兼容；迁移指南。
- **Vitest 兼容**：API 命名尽量同名，提供 `vitest` 别名导出降低迁移摩擦。
- **类型测试**：`expectTypeOf`/`assertType`（expect-type 集成），`*.test-d.ts` 仅类型检查不执行。
- **基准测试**：`bench`/`describe.bench` + Tinybench，`lightning bench`，结果对比/回归告警。
- **未捕获错误报告**：unhandled rejection / uncaught exception 归因到测试。
- **武陵 DevOps 集成**（planned）：测试结果/覆盖率/趋势上报武陵 Test Plan（对齐 Nasti 2.0 武陵 DevOps 接线）。

**交付物**：兼容层、`@lightning-js/bench`、类型测试 runner、武陵 reporter。

---

## 3. 跨阶段工程事项

- **构建**：沿用 `tsdown`（已配），ESM-first，导出 `defineConfig`/`lightning` 编程 API + `bin/lightning`。
- **版本锁定**：对 `rolldown/experimental` 的实验导出守卫导入 + peerDep 锁 Nasti 版本范围。
- **自举（dogfooding）**：Lightning 一旦到 Phase 2，用自身测试自己（README 已声明 `test` 脚本是占位）。
- **示例 / playground**：建 `playground/`（对齐 Nasti），含 node/react/vue 各一套测试样例做回归。
- **CI**：GitHub Actions，矩阵跑 playground，sharding 自测。
- **文档站**：对齐 Nasti（`website/`），中英双语。

---

## 4. 命名与待决问题

- **命名主题**：Nasti 取自明日方舟干员；包描述自称"比神霄派雷法还快"。测试 API 默认走 Jest/Vitest 同名（`test`/`expect`/`vi`）以保证兼容——**不为主题牺牲迁移性**。可在品牌层（CLI banner、reporter 文案、debug 命名空间 `lightning:*`）体现雷法主题。
- **`vi` 命名空间名**：保留 `vi` 以兼容 Vitest 生态？还是用 `lt`/`lightning`？建议**双导出**（`vi` 别名 + 原生名），降低迁移摩擦。— 待决
- **完整打包模式**：测试是否提供 opt-in 的 bundled 执行（更接近生产、更快冷启动 vs 失去逐模块隔离）？默认 unbundled。— Phase 4+ 评估
- **是否 monorepo**：MVP 单包，Phase 2 评估拆包（expect/spy/runner 可独立复用价值高）。— 待决

---

## 5. 里程碑摘要

| Phase | 主题 | 核心验收 |
|---|---|---|
| 0 | MVP 链路 | `lightning run` 串行跑通、退出码正确 |
| 1 | Pool + 隔离 | 并行 + 文件级隔离 + 超时/重试 |
| 2 | 断言/Mock/快照 | 迁移 Vitest 样例全绿 |
| 3 | Watch | 改一处只重跑受影响测试 |
| 4 | 环境/覆盖率/报告/分片 | jsdom + v8 覆盖率 + JUnit + shard |
| 5 | 浏览器模式 | Playwright 组件测试 |
| 6 | 兼容/类型/基准/武陵 | Jest/Vitest 兼容 + 类型测试 + bench |

> **下一步**：评审本 ROADMAP → 锁定 Phase 0 范围 → 搭 `lightning.config.ts` + `test` 环境接线 + 最小 runtime，打通第一条绿色用例。
