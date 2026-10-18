---
Status: implemented
Date: 2026-10-18
---
# 档位探针吃模型真名；adaptive Claude 按注册表声明透传 xhigh

## 决定了什么

- **B（E0 / E4）**：`EffortCapability` 新增 `wireModel`，由 `finalizeThinkingControl`（`resolveEffortCapability` 三个出口都经过它）挂上解析时的真名。`previewWireEffort` / `isEffortGatedByThinking` 的探针改用这个真名，不再喂空名。空名会让 Anthropic applier 的 `lookupCatalog` 必 miss，5.x Claude 全被当成 manual 旧模型。门控探针同时识别 `thinking.budgetTokens`（manual Claude 的强度载体），不再只读档位字段。
- **D（E2 实发）**：注册表新增 `supportsXhighEffort`，按官方矩阵（anthropic-api.md:417）给 Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Fable 5.1 / Fable 5 / Mythos 5 / Opus 5 / Sonnet 5 / Opus 4.8 / Opus 4.7 标 true。adaptive applier 只在**精确命中**且声明时透传 xhigh，其余照旧钳 max。`SendParams.outputConfig.effort` 类型放开 xhigh；`dialect/anthropic.md` 那句「官方不含 xhigh」已更正。
- 行为变化：5.x Claude 选 xhigh 实发 xhigh（此前 max）；Opus 5 / Sonnet 5 / manual Claude 上 `/think off` 后面板提示「档位不生效」（此前不提示）；Opus 4.6 等未声明的 adaptive 模型面板里不再列 xhigh，xhigh 被 reconcile 归正为 max（此前显示 xhigh、实发 max）。

## 放弃了什么（以及为什么不选）

- **B 单独先上**：探针一吃真名，xhigh 在 5.x 上被判成「实发 max」，面板剔掉 xhigh，切模型 / resume 时 reconcile 会把用户的 xhigh 改写成 max。官方认 xhigh，所以 B 和 D 必须同一个 PR。
- **探针加 `model` 参数**：所有调用方（EffortDialog / ModelDialog / model-profile / reconcile / `/effort`）都得改签名并各自传真名，口径又多出 N 份。挂在 cap 上，只有一个出口负责写。
- **按模型名前缀判 xhigh**（如 `/claude-(opus|sonnet)-5/`）：违反「禁按模型硬编码分级」，而且会把未来小版本外推进去。走注册表数据。
- **模糊命中也认 `supportsXhighEffort`**：`claude-opus-4-6` 会借到 4.7 的声明，`claude-opus-5-6` 会借到 5 的声明。同 `thinkingOmitMeans`，只认精确命中，不知道就不猜。
- **补钳制提示，不改实发**：用户选 xhigh 时照发 max，只多一句提示。这不尊重用户选的档，而且官方认 xhigh。

## 拿什么证明它生效了

- 新测试 `packages/core/tests/llm/effort-probe-wire-model.test.ts`：10 pass。
- 变异自证（三处，改坏后均已还原）：
  - applier 改回无条件 xhigh→max：3 条红（D 透传、previewWireEffort、5 档可选集）。
  - 探针改回空名：3 条红（previewWireEffort、always-on 门控、未声明模型归正）。
  - 门控探针去掉 budget 识别：1 条红（manual 门控）。
- `model-effort-cycle.test.ts` 原有一条「Claude 不报门控」锁的正是 E4 的旧行为，已改成 Opus 5 报门控、Opus 5.5 不报。
- `bun run affected-tests:run` 2052 pass / 0 fail；`packages/cli/tests/command` + `ui` 1777 pass / 0 fail；`make build` 自检通过；typecheck:gate 66/66 无新增；lint / format:check / lint:boundary / lint:command-system / docs:gen-reference --check 全绿。
- 线上证据：Opus 5.5（uniapi）、Sonnet 5（会校验 effort 的 ppchat 渠道）的 xhigh 真响应 200（排查文档 E2）。其余已声明模型只有文档依据，发版后用 #346 的 `effort_wire` 按模型盯 xhigh 档的 400 率。
