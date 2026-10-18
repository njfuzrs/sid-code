---
Status: implemented
Date: 2026-10-18
---
# resume 恢复跨 provider 模型时重建 provider；线上实发 effort 档与用户所选档入轨迹

## 决定了什么

- **E11（P0）**：`restoreSession` 恢复 `agent_setting.model` 时，调用新抽出的
  `rebuildProviderForCurrentModel()`（clearCache → getProvider → queryEngine.updateProvider），
  与 `applyPrimaryModelSwitch` 共用同一份实现。原注释「让 doInit 采用」与代码不符：provider 在
  `cli.ts` 构造 App 之前就已建好，QueryEngine 构造期拿到它，doInit 不重建。快照模型的 provider
  建不起来时回退到启动模型，不留下「config.model 是新的、provider 是旧端点」的错配。
- **A（E9 仪器）**：
  - `BilledRequest.effortWire` / events.jsonl `effort_wire`：**读最终请求体**——Anthropic 取
    `output_config.effort`（已扣 `dropEffort`），Chat Completions 取 `reasoning_effort`，Responses
    取 `reasoning.effort`；没发写 `omitted`，未接线路径缺省。覆盖 Anthropic 流式/非流式、
    OpenAI Chat 流式/非流式、Responses 流式/非流式六条出口。
  - raw.jsonl request 侧 `effort_intent`：env > runtime > `auto`，在 applier 之前取，不做
    auto→默认档、ultrathink 提级。

## 放弃了什么（以及为什么不选）

- **A 在会话开头写 agent_setting 快照**：resume 读到快照就切模型，每个会话都写会让跨 provider
  resume 变成常态，正好落进 E11。改用逐请求的 `effort_intent`。
- **A 记 `sendParams.outputConfig` / `reasoningEffort`**：那是 applier 的内部表示，线格式层还会改
  （关思考 `dropEffort`、max 被拒、能力自愈剥字段），记它等于再造一个「记录 ≠ 实发」的仪器。
- **E11 走 `applyPrimaryModelSwitch`**：它会触发 model_switch hook、清 terminal 拉黑、持久化等
  「用户显式切换」语义，恢复不是切换。只共用 provider 重建这一步。

## 拿什么证明它生效了

- `packages/cli/tests/app/resume-cross-provider-rebuild.test.ts`：真实 ProviderRegistry，
  Claude 启动 + DeepSeek 快照 → `queryEngine.deps.provider` 是 DeepSeek baseURL 的实例。
  变异：删掉 restoreSession 里的重建调用 → 红在 provider 断言（`expected` vs 旧实例）。
- `packages/core/tests/llm/thinking-observation-wiring.test.ts` E9 组 5 条：断言请求体与
  `effortWire` 一致。变异：Anthropic 改记 `params.outputConfig.effort`、OpenAI 标签恒 omitted →
  3 条红（关思考 omitted / Chat max / Responses xhigh）。
- `packages/core/tests/query/effort-intent-before-model.test.ts`：真实 queryLoop。变异：去掉
  env 优先 → 「env 覆盖优先于 runtime」红。
- 未做：真网关 / 真机 TUI resume 复现；线上分布曲线需要发版后从轨迹取数。
