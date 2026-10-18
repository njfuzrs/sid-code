---
Status: implemented
Date: 2026-10-19
---
# DeepSeek 档位对齐官方映射，auto 态 Footer 显示服务端实际默认档

来源：20261018 effort 排查 §4 顺序 4（PR-E，E5）+ 顺序 5（PR-F1，E1 / E8 / E10 默认档部分）。

## 决定了什么

- **E（改线上请求）**：`dialect/deepseek.ts` `toDeepSeekWireEffort` 改为官方现行映射：
  `low` 原样、`medium` / `xhigh` → `high`、`max` 原样。OpenAI 协议（`reasoning_effort`）与
  Anthropic 兼容端点（`output_config.effort`）共用这一个函数，两条同时生效。可选档由
  `high, max` 变为 `low, high, max`。`dialect/deepseek.md` 同步改写。
- **F1（只改展示）**：
  - 注册表新增可选字段 `defaultEffort`（不发 effort 时服务端按哪档跑），只认精确命中，
    在 `finalizeThinkingControl` 里覆盖族常量。登记：kimi-k3 = max、Grok 4.5 / 4.6 / 4.7 = high、
    GLM-5.2 / 5.3 / 5.3-flash / 5.3-flashx = max、Opus 5.5 / Haiku 5.5 = medium。
  - 能力缓存新增 `defaultEffort`，从 OpenRouter `reasoning.default_effort` 采集；未知族优先用它，
    没有才按档位表猜。优先级：注册表精确命中 > 能力缓存 > 族常量。
  - `getDisplayedEffort` 的 auto 分支改为先预演 applier：auto 时**显式发了档**就显示发的那档
    （manual Claude 开思考发 10000 预算 → 显示 medium，修 E1；adaptive Claude 发 high → 显示 high），
    没发才显示 `defaultEffort`。
- 线上请求在 F1 部分**不变**，有测试锁住。

## 放弃了什么（以及为什么不选）

- **按模型名写死默认档**（如 `model.startsWith("grok-4.5")`）：违反「禁按模型硬编码分级」，
  新版本要改代码。走注册表数据 + 能力缓存。
- **注册表 `defaultEffort` 走模糊匹配**：会让未登记的小版本（`grok-4.8`）借 4.7 的 high。
  与 `supportsXhighEffort` / `thinkingOmitMeans` 同口径只认精确命中，未登记退到族常量。
- **让 Opus 5.5 / Haiku 5.5 的 auto 直接显示 medium**：auto 目前线上显式发 high，显示 medium
  就又是「展示 ≠ 实发」，和 PR-C 刚立的不变式冲突。登记了数据，等 F2 改成 auto 不发 effort 时自然生效。
- **E 和 F1 拆成两个 PR**：同一条展示链路（`getDisplayedEffort` / `getSelectableEfforts`），
  同优先级 P1，按「一个 PR = 一次 review 完」合并；F2（改线上、可能回滚）仍单独。
- **接 DeepSeek 的 `none`**：sid 关思考走 `thinking:{type:"disabled"}`，两条线语义重复；
  真网关上 `none` + `thinking:enabled` 仍出 reasoning token，没测清，不接。
- **能力缓存的 `defaultEffort` 参与多源投票**：同 `effortValues`，取第一个报了的源，不投票。

## 拿什么证明它生效了

- 新增 `packages/core/tests/llm/effort-default-display.test.ts` 14 条：kimi-k3 / Grok / GLM 的
  auto 展示、`grok-4.8` 不借值、默认档恒在可选集内、manual Claude auto 显示 medium、
  缓存 `defaultEffort` 采信与 sanitize、注册表优先于缓存、auto 的请求体不变。
- 改了锁旧映射的断言：`dialect-parity.test.ts`（另加 Anthropic 端点同映射一条）、`effort.test.ts`、
  `model-effort-cycle.test.ts`。
- 变异自证 4 处，均红在对应断言：DeepSeek 映射改回旧表 9 红；去掉注册表默认档覆盖 6 红；
  auto 展示改回只取族常量 2 红；不采信缓存 `defaultEffort` 1 红。恢复后 0 红。
- 门禁：`bun run affected-tests:run`、`make build`、`typecheck:gate`、`lint`、`format:check`，结果见 PR 正文。
- 未做：DeepSeek Anthropic 兼容端点的 low / xhigh 真响应（排查只测了 OpenAI 协议）。
  发版后从轨迹 `effort_wire` 看 DeepSeek 两条路径 low / high 的分布和 400 率。
  真机 TUI 走查未做。
