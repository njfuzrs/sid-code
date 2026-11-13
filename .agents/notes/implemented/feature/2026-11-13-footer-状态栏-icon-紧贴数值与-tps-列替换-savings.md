---
Status: implemented
Date: 2026-11-13
---
# Footer 状态栏：icon 紧贴数值，savings 那格换成会话输出吞吐（⇢41/s）

## 决定了什么

三处视觉/信息变更，全部落在行1（对话内的会话计量段）：

1. **icon 与数值之间不留空格**：`⟳ 12` → `⟳12`，`⚠ skip-perms` → `⚠skip-perms`。
   两处空格是历史遗留的字符串拼接（`Footer.tsx` 的 `<Text>{RETRY_MARK} </Text>` 与
   `useStatusLineData.ts` 的 `` `${RETRY_MARK} ${n}` ``），删掉即可。`✘3` 与 `⟳12` 之间的
   那个空格**保留**——它是两个子项的分隔，不是 icon-数值间隙。
2. **`⚡` → `↯`（`CACHE_MARK`）**：`⚡`(U+26A1) 实测宽度 **2 列**且字形右侧自带字面留白，
   于是 `⚡71%` 在终端里看着像 `⚡ 71%`——代码里没有空格可删，只能换字形。
   `↯`(U+21AF) 实测宽度 1，语义仍是「闪电/加速」。顺带按 L1.1 把硬编码的 `⚡` 收口进
   `constants/figures.ts`（此前它同时硬编码在 `Footer.tsx` 与 `useStatusLineData.ts` 两处）。
3. **`$0.048 saved` → `⇢41/s`**：savings 那一格换成**会话累计输出吞吐**，位置、`dropOrder: 5`、
   窄屏丢弃次序都不变（scroll→requests→tps→cache→cost→tokens→context）。
   数据来自 `TraceCollector.getOutputTps()`，内部原样复用 `trace/builder.ts` 的
   `deriveOutputTps`（`total_tokens_received ÷ total_gen_elapsed_ms`）——与 `/perf` 的
   「生成速度」同源同数，一个指标两个出口。UI 侧**不做除法**，`deriveTps` 只负责格式化成
   `⇢41/s`（取整、单位最短）。

为什么把「省了多少钱」换成「每秒多少 token」：保存金额是**事后收益**，吞吐是**此刻的等待预期**
（长输出还要等多久）。后者才是常驻状态栏该回答的问题；前者 `/cost` 与 `/stats` 都还能查到。

## 放弃了什么（以及为什么不选）

- **保留 `⚡`、只「接受它看起来有个空格」**：用户提的正是这个视觉间隙。emoji-width 字形的
  右侧留白无法用代码消除，唯一解是换宽度稳定的单色字形。
- **tps 也用 `↯`（原方案的建议写法 `↯41/s`）**：需求一已把缓存列换成 `↯`，同一行出现两个
  `↯` 会看混。改为 `⇢`（U+21E2 右向虚线箭头，宽度 1，语义「数据在往外流」），与 `↯` 形状差异明显。
- **`⇢41 tok/s`**：多 4 列。行1 是最拥挤的一行，窄屏上这 4 列足以挤掉一整段。
- **TTFT 作为状态栏指标**：交互延迟感知确实更强，但需要新的聚合口径（均值/中位/最近一次？），
  且单轮值受缓存命中影响能差数倍（`/perf` 的 `ttftByCache` 里 hit/miss P50 差距就是证据），
  挂常驻列会一直跳。
- **端到端 e2e 速度**：含工具执行时间，跨轮差异巨大，聚合口径最难定，且与「模型生成快慢」
  这个用户真正关心的问题混在一起。
- **把 `cacheSavingsUSD` 整条 prop 链一起清掉**（原方案的建议）：回源码核实后发现
  `BottomRegion` 的这个 prop 有**两个消费方**——Footer（本次移除）与 `DialogSwitch→StatsDialog`
  （`/stats` 面板的「缓存节省」行）。删掉会让 `/stats` 少一行。所以只删 Footer 那一格，
  `TUIState.cacheSavingsUSD` / `BottomRegion` / `cost-bridge` / `app.ts` 的 5 处推送全部保留。
  core 侧的 `getTotalCacheSavings()` 同样保留（`/cost`、账本、遥测都在用）。
- **让 `SessionState` 自己累加 gen elapsed 当数据源**：需要在 llm 流收尾处新增一条跨层埋点，
  且一旦与 `deriveOutputTps` 的口径漂移，状态栏和 `/perf` 就会各说各话。用 collector 已有的
  metadata 是零新埋点 + 同源同数。
- **代价（点破）**：`trace.enabled=false` 时 `getOutputTps()` 返回 `undefined`，该列不显示。
  这是刻意的——没有流级样本时落一个 `⇢0/s` 会被读成「生成极慢」，比不显示更糟。
  `/perf` 本身也依赖轨迹落盘，两者降级口径一致。

## 拿什么证明它生效了

新增/更新的测试（全部本地跑过）：

- `packages/cli/tests/ui/components/footer-tps.test.tsx`（新增 8 例，整帧渲染）：
  `⇢41/s` 渲染、小数取整、`undefined`/`0` 不渲染、**改 usage 不改读数（证明没重算）**、
  宽/窄屏不溢出、**逐档收窄终端断言「⇢ 已消失但 ↯ 还在」**（证明 dropOrder 5 仍是「比 cache 先丢」）。
- `packages/cli/tests/ui/components/footer-requests-column.test.tsx`：`⟳ 12` → `⟳12`（含整帧）。
- `packages/cli/tests/ui/components/footer-cache-hit-rate.test.tsx`：`⚡78%` → `↯78%`（含窄屏丢弃）。
- `packages/cli/tests/ui/status-line-data.test.ts`：`deriveCacheMetrics` 断言换字形 + 新增
  `deriveTps` 5 例（`undefined`/0/负数/NaN → null，41.4→41，41.6→42，无空格、无 `tok/s`）。
- `packages/cli/tests/ui/cost-bridge.test.ts`（新增 3 例）：每笔入账重读 getter、getter 返回
  `undefined` 时落 `undefined` 而不是 0、省略 getter 时其余字段照常推。
- `packages/core/tests/trace/collector-output-tps.test.ts`（新增 4 例）：未初始化 → `undefined`、
  与 `deriveOutputTps` 同值（500 tok / 10s = 50）、`gen_samples=0` → `undefined`、分母 0 → `undefined`。
- `packages/cli/tests/ui/components/__snapshots__/layout-bottom-region-snapshot.test.tsx.snap`：
  4 个快照同步更新，diff **只有** `⟳ 3` → `⟳3` 一处/帧（逐行看过，无行宽溢出、无 savings 残留）。

变异自证（改坏 → 确认红 → 恢复，共 4 组）：

| 改坏点 | 变红的断言 |
| --- | --- |
| `deriveTps` 去掉 `Math.round` | footer-tps 取整 2 例 + deriveTps 单测 2 例 |
| `Footer` 的 `{RETRY_MARK}` 加回尾随空格 | footer-requests 整帧 3 例 |
| tps 段 `dropOrder: 5` → `-1`（永不丢弃） | 「⇢ 先于 ↯ 被丢」那 1 例 |
| `getOutputTps` 去掉 `if (!this.initialized)` | collector 未初始化 1 例 |

门禁输出：

- `bun run typecheck:gate` → `当前 62 处错误 / 基线 62 处 ✓ 无新增类型错误`。
- `bun run affected-tests:run` → 4449 tests across 402 files：4436 pass / 4 fail（那 4 个就是
  上面同步更新的快照，更新后 `7 pass / 0 fail`）/ 9 skip。
- `bun run lint` → `0 warnings and 0 errors`；`bun run format:check` → 全部合规。
- `bun run lint:boundary` / `lint:command-system` / `lint:legacy-tool` → 三道全过。
- `make build` → 编译成功 + 产物自检通过。
- `bun run smoke` → `28 例：28 通过，0 失败，0 跳过（binary）`。
