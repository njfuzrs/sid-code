---
Status: implemented
Date: 2026-11-18
Source: auto 权限档误报弹窗与分类器缺用户意图 —— 修复与验收方案（2026-11-17）
---
# auto 档每条决策都落盘分类器结论、耗时与理由（PR0）

## 决定了什么

触发会话 `20261117-134629-f2956b40` 的两次 auto 档确认，轨迹里只有
`auto_classifier=unsafe` 一个枚举、审计里只有 `"reason":"用户批准"`，
「分类器为什么判 unsafe」在两条链上都查不到。两个根因各自独立：

1. **放行那条路径根本不带 metadata**：`checker.ts` 的 auto 分支在分类器批准时
   `return { allowed, decisionReason, step }` 直接返回，于是「auto 档自动放行了多少次」
   在盘上没有分子 —— 只能靠「没弹窗」反推，而反推分不出「分类器批的」与「规则直放的」；
2. 回退路径虽有一个枚举，但没有耗时 / 风险 / 理由。

这次改动把「分类器说过话」的那一次变成一条可查询的事实：

- `ToolClassifyResult` 新增**必填** `via: "fast-path" | "llm" | "none"`。
  必填是刻意选的：可选字段的默认值等于「不知道」，而「不知道」在落盘上与
  「没走过分类器」长得一模一样。类型检查逼每条返回路径表态（`fastPath` 三处、
  `!isAvailable()` 一处、LLM 成功 / 解析失败 ×2 / 抛异常四处）。
- `checker.ts` 的 auto 分支新增 `autoClassifyFactsOf(result)`，放行与回退共用同一份
  三件套（`classifierMs` / `classifierRisk` / `classifierReason`），放行时额外落
  `autoClassifier = "fast-path" | "llm-safe"`（两个新取值）。
- `decision-telemetry.ts` 的 `decisionFactsOf` 里并入 `classifierFactsOf`：
  C1 的整个教训就是「放行那条路径没人补字段」，并进这个既有出口，
  「新鉴权分支忘了传」才没有复现空间。
- `collector.ts` 映射为 `auto_classifier` / `classifier_ms` / `classifier_risk` / `classifier_reason`；
  审计终局行（`auditConfirmationOutcome`）追加 `auto_classifier` / `classifier_reason`。
- 外发遥测只加 `auto_classifier`（枚举）与 `classifier_ms`（数字）；`classifier_reason`
  与 `classifier_risk` 登记进 `LOCAL_ONLY_EVENT_DATA_FIELDS`，上传前剥掉。

两处刻意的「不填」，都写在源码注释里：

- `fast-path` 不带 `classifierMs`（没发请求）。填 0 会把「零成本」记成「一次 0ms 的调用」，
  与真的 0ms 返回混在一起，「auto 档省了多少」的归因直接作废。
- `classifierUnavailable` 时不带 `classifierRisk`：那几条路径的 `risk` 是硬编码占位值
  `medium`，不是模型判的，落盘会变成「分类器说风险中等」这种没发生过的事实。

**口径变更提醒**：`autoClassifier` 从「只有回退才有值」变成「放行也有值」。
仓库内已 grep 确认没有「字段有值即视为回退」的消费方（`digest.ts`、`scripts/`、
`packages/cli/src` 均无引用）。**如果远端看板按「`autoClassifier` 非空」统计回退数，
需要同步改成按取值过滤**（`fast-path` / `llm-safe` 是放行，其余是回退）。

## 放弃了什么（以及为什么不选）

- **放弃「只用 `latencyMs` 有没有值来区分快速路径与 LLM」**：`latencyMs` 缺失有两种成因
  （fastPath 没发请求 / 分类器不可用），把它们合成一个信号，就没法回答
  「auto 档省了几次弹窗」与「分类器花了多少钱」这两个相反的问题。所以单开 `via`。
- **放弃「在 `events.ts` 里让调用点各自传 `classifierMs` 等三件套」**：那样 7 个
  `logPermissionAllow` / `logPermissionDeny` 调用点各写三行，下一个新鉴权分支漏抄几行
  就是静默缺字段（B11 的 `confirm_via` 正是这么丢的）。并进 `decisionFactsOf` 统一发放。
- **放弃「把 `classifierReason` 也外发」**：它是模型自由生成的文本，长度无上界、
  可能复述命令片段或路径，与 `input_summary` 属同一类。外发 schema 只加枚举与数字。
- **放弃「把整份 `Decision.metadata` 塞进审计」**：metadata 里还可能有其它字段
  （如 `denialTrackingTriggered` 布尔位），审计的字段集应当可枚举。只取两项且截断 200 字。
- **放弃「在 auto 放行分支另起一个新的 log 出口」**：放行仍走原有 `logPermissionAllow`
  （`source: "rule"`、`needsPrompt: false`），只补 metadata。决策成因与 `step` 不变，
  避免动到 PR2 要复用的既有判据。

## 拿什么证明它生效了

三条变异自证（逐条改坏 → 跑测试 → 贴红色输出 → 恢复，恢复后三个文件与备份 `diff -q` 一致）：

1. **删掉放行分支的 `metadata`** → 5 条变红：
   `快速路径放行 → autoClassifier=fast-path`、`LLM 判安全 → llm-safe`，
   以及落盘组的 `llm-safe 四项都有值` / `fast-path 只落枚举` / 外发 payload 那条。
2. **删掉 collector 的 `classifier_ms` 映射** → 落盘组
   `llm-safe：auto_classifier / classifier_ms / classifier_risk / classifier_reason 四项都有值`
   变红（`expected undefined to be number`）。这一条正是 §4.1.3 点名的「两端都写对了、
   collector 漏映射」形态，也是它必须从 `check()` 一路断言到 `events.jsonl` 的理由。
3. **把 `classifier_reason` 加进外发 payload** → 隐私断言
   `permission_allow 的 payload 有 auto_classifier / classifier_ms，没有 classifier_reason` 变红。

新增用例（`bun test` 两个文件 20 pass / 0 fail）：

- `packages/core/tests/permission/auto-classifier-verdict-telemetry.test.ts`（15 条）：
  fast-path / llm-safe / unsafe / 超时 / ask-rule 五种 metadata 形态；`via` 的八条返回路径；
  审计终局行带值 / 不带 metadata 时不出现该字段；理由截断到 200 字。
- `packages/core/tests/trace/auto-classifier-verdict-landing.test.ts`（5 条）：
  真实 checker（auto 模式）→ `logPermissionAllow(…decisionFactsOf)` → 真实 collector
  → 读 `events.jsonl` 原文，断言四个字段；`fast-path` 不带 `classifier_ms`；
  外发 sink 收到的 payload 有枚举与数字、无理由；`stripLocalOnlyEventFields` 剥对字段。

门禁：`bun run affected-tests:run`（analytics / permission / query / trace 四个目录）、
`make build`、`bun run smoke`、`bun run lint`、`bun run format:check`、
`bun run typecheck:gate`（62/62，无新增）。
