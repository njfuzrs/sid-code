---
Status: implemented
Date: 2026-11-18
Source: context 面板取数不准与信息缺失·修复与验收方案（2026-11-17）
---
# BeforeModel 的 `ctx_estimated_tokens` 回到「全量历史」口径，并给分析脚本加漂移检测

## 决定了什么

`packages/core/src/query/loop.ts` 里 `ctx_estimated_tokens` 的取值，从 PR2 迁移后的
`ctxMgr.getSendTokens(toolCount)`（发送量，已扣本地释放量）改回
`ctxMgr.getHistoryTokens(toolCount)`（全量历史，含锚点，不扣释放量）。

这一处本来在 PR0 就是 `estimateTokens()`，语义是「预测发送量 = ctx_estimated_tokens −
ctx_freed_tokens」。PR2 把 27 处调用点统一迁到「发送量 / 全量历史」两个具名 API 时，
把这一处也一起换成了发送量——而它属于**度量**语义（只进轨迹、供对账），该用全量历史。
于是 `estimated − freed` 变成**双重扣减**。

配套两项：
- `scripts/context-estimate-baseline.ts` 新增 `implausibleEstimates`：统计
  `ctx_estimated_tokens < ctx_freed_tokens` 的调用数（物理上不可能），文本报告里醒目告警。
- 两条回归测试：一条钉死 `loop.ts` 这一行的取值（源码字面量断言），一条覆盖脚本的检测。

## 放弃了什么（以及为什么不选）

**放弃「改分析脚本的 pred 公式为 `estimated`（不扣 freed）」**。这是最小改动，且已跑完的
E1 轨迹能直接复用（它们的 estimated 正是发送量）。不选它的理由：改口径是自我欺骗的高发
路径——预登记公式、`hook/types.ts` 字段注释、`collector.ts` 注释、方案 §8.3 四处都写着
「未扣本地释放量」，只有实现一处漂了。**四处对一处时该改的是那一处，不是四处。**
而且 `ctx_anchor_tokens === ctx_estimated_tokens`（「锚点抬升生效」）这条判据要求两者同口径，
`ctx_freed_tokens` 字段的用途也建立在「estimated 是全量」之上；改公式会让这两个字段同时失效。

**放弃「字段语义保持发送量、另加一个全量历史字段」**：四件套已经是 4 个字段，再加一个会让
「哪个是对账用的」变成需要读注释才知道的事，而这次的教训恰好是注释与实现不一致。

## 拿什么证明它生效了

1. **缺陷是被端到端验收抓出来的，不是推理出来的**：E1 用修复前二进制（`71feae3e`，含 PR2）
   跑 S1/S2/S3 各 3 次，`context-estimate-baseline.ts` 算出 S1-run2 `|err|p95 = 31.1%`、
   S2-run2 `117.7%`；同一批轨迹按实测字段语义（`pred = estimated`）复算为 `4.2%` / `5.5%`。
   `freed = 0` 的 E0 会话两种口径**逐位相同**——这正是它能在 PR review 中漏过去的原因。
2. **源码定位**：`loop.ts:3231` 的 `sendEstimatedInputTokens = ctxMgr.getSendTokens(toolCount)`
   → `manager.ts:2263 sendTokensFrom()` = `max(0, estimateTokens − localReductionTokens())`；
   而 `ctx_freed_tokens` = `getLocalFreedTokens()` = 同一个 `localReductionTokens()`。
   两者相减即双重扣减。对照 E0 的提交 `31d72121`，同一行当时是 `ctxMgr.estimateTokens()`。
3. **变异自证**（两处各做一次，都看到精确变红后恢复）：
   - 把 `loop.ts` 改回 `ctx_estimated_tokens: sendEstimatedInputTokens` →
     `before-model-context-estimate.test.ts` 报
     `Expected: "ctxMgr.getHistoryTokens(toolCount)" / Received: "sendEstimatedInputTokens"`。
   - 把 `implausibleEstimates` 改成恒 `0` →
     脚本单测报 `Expected: 1 / Received: 0`。
4. `bun test ./packages/core/tests/trace/before-model-context-estimate.test.ts
   ./tests/scripts/context-estimate-baseline.test.ts` → 20 pass / 0 fail；
   `bun run affected-tests:run` → 4854 pass / 1 skip（需 vitepress build 的那条）/ 0 fail；
   `make build` → 编译产物自检通过。
5. **E1 用修复后的二进制重跑**（见方案文档 E1 记录）：修复后
   `ctx_estimated_tokens` 为全量历史，`estimated − freed` 与真实 input 的 p95 误差回到
   个位数百分比。
