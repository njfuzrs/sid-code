---
Status: implemented
Date: 2026-11-19
Source: 缓存断裂归因失效与命中口径 —— 缺陷复核与修复方案（2026-11-19）
---
# 命中率的「可信度」用标注表达，不用隐藏（D5 / D5b / D6）

## 决定了什么

三处标注型缺陷一起改，共同点是「数字照常给，但必须告诉用户它该怎么读」：

1. **D5 · Footer 不过滤 channelTrust**。`SessionState` 新增 `channelTrust` 字段 +
   `setChannelTrust()` / `isChannelUntrusted()`；`loop.ts` 在 `updateUsage(...)` **之后无条件**
   写一次（`SessionState.hostOf(config.baseURL)` + `lookupChannelTrust(host, readChannelTrustCached())`）。
   `getCacheHitRate()` **刻意不按它过滤**；命中率照常推到 Footer，只在不可信时渲染成 `↯96%?`
   （新字形常量 `CHANNEL_UNTRUSTED_MARK = "?"`）。`/cost` 的 `main.sessionNotes` 多一行说明。
   `resetCounters()` 一并清掉该字段。
2. **D5b · `getCacheHealthAdvice` 读类别不读文案**。三处 `changes.some(c => c.includes(...))`
   改成 `categories.includes("system_prompt" / "tools" | "tool_order" / "model")`。
3. **D6 · provider 末次覆盖（方案 C 先止血）**。同一 model 名下 `provider` 变更时，
   `ModelUsageStats.providerSwitched = true` + 一条 SESSION WARN，按 `(model, 新 provider)` 去重；
   `/cost` 标注「本会话换过协议族，命中率按末次口径」。

两个刻意的落点选择：

- **D5 写入点不能在 `if (breakReport)` 分支里**。那个分支只有「发生了缓存断裂」才走，
  而不可信渠道恰恰常常「看起来没断裂」（它的 `cache_read` 是编的，骤降判据经常不触发）。
  放进去丢掉的正好是最该标记的那批会话。回归：`loop-channel-trust.test.ts` 的
  「无断裂（首轮）+ untrusted 端点 → 标记仍然出现」。
- **D6 的 WARN 在 `updateUsage` 里，不在 `getCacheHitRate` 里**。后者是渲染路径
  （cost-bridge / app.ts 高频读取），放进去会刷屏 —— 与方案 §13 第 4 行点出的坑同型。

## 放弃了什么（以及为什么不选）

- **D5 在 `getCacheHitRate()` 里直接过滤 untrusted**：会让 Footer 显示 `undefined`（整列消失），
  用户会以为「缓存坏了」，而真相是「这个渠道的数不能信」。隐藏比标注更容易误读。
- **D5 在 UI 层自己查渠道登记表**：会在 cli 与 core 之间造出第二份判据，并让 UI 依赖
  `~/.sid-code/channel-trust.json` 的读盘时机。判定留在 core（每轮入账时写一次），UI 只透传。
- **D6 方案 A（按 `(model, provider)` 二维分桶）/ 方案 B（冻结历史累计为归一化三段）**：
  改动面分别是大 / 中等，且 `modelUsage` 的消费方很多（/cost、SessionStats、账本、准入门禁）。
  本次先取方案 C 止血（留痕 + WARN + 标注），口径本身不动；B 作为后续单独立项。
- **`tool_order` 单独一类建议**：它与 `tools` 的修复建议相同（固定序列化顺序），
  按元原则「同族合并」并进同一格，而不是新增第三种提示。

## 拿什么证明它生效了

跑过的命令与结果：

- `bun test ./packages/cli/tests/ui/ ./packages/cli/tests/command/ ./packages/core/tests/api/
  ./packages/core/tests/session/ ./packages/core/tests/query/`
  → **4294 pass / 1 skip / 0 fail**（399 文件）。
- `bun run typecheck:gate` → 「当前 62 处错误 / 基线 62 处，✓ 无新增类型错误」。
- `bun run lint` → 0 warnings 0 errors；`bun run format:check` → 全部合规。

变异自证（每条都真做过：改坏 → 看到指定断言变红 → 恢复 → 全绿）：

1. 去掉 `Footer.tsx` 里的 `?` 渲染 → `footer-channel-trust.test.tsx`
   「传 cacheChannelUntrusted → 命中率后出现 `?`」红，
   报文 `Expected to contain: "↯96%?" / Received: "... · ↯96%"`。
2. 把 `loop.ts` 的 `setChannelTrust` 挪进 `if (breakReport)` 分支 → `loop-channel-trust.test.ts`
   三条全红，首条报文 `Expected: "untrusted" / Received: undefined`
   —— 正是「无断裂就取不到 trust」的原缺陷形态。
3. `getCacheHealthAdvice` 判据改回 `changes.includes(...)` → `cache-detection.test.ts`
   D5b 三条全红（「文案含但类别不含 → 误给建议」「文案被改写 → 建议消失」）。
4. 去掉 `state.ts` 的 `prevProvider !== prov` 判定 → D6 的 WARN 用例
   `Expected number of calls: 1 / Received: 0`，`/cost` 说明行用例同时红。
5. `cost-bridge.ts` 把 `cacheChannelUntrusted` 写死 `false` → `cost-bridge.test.ts`
   两条 D5 用例红（`Expected: true / Received: false`）。

未覆盖/留待主控复核的点：G2 无头回放未加用例（本单元的判据是纯函数 + props 透传，
G1 足够；Footer 标记是 G4 级视觉判据，本次用整帧渲染测试覆盖）。
