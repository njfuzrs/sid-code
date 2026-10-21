---
Status: implemented
Date: 2026-10-21
---
# Responses 路径捕获并回放 reasoning item（新块型 provider_reasoning），带回放开关与网关能力位

## 决定了什么

- 新块型 `ProviderReasoningBlock`（`type:"provider_reasoning"`，字段 `protocol/model/item`），加进 `ContentBlock` 闭集与 `sdk/schemas.ts` 的 zod 闭集。
- 捕获：`openai-responses.ts` 在 `response.output_item.done` 遇到带 `encrypted_content` 的 reasoning item 时发一个 start+stop 块；非流式 `parseResponsesBody` 同步处理。没有密文的 item 不存（store:false 下回放它只会 400）。
- 回放：`buildResponsesRequest` 遇到同协议、同模型的块，就地还原成 `{type:"reasoning", ...item}`（去掉 `status`），位置在对应 function_call 之前；跨模型丢弃。不加 `include`。
- 过滤：
  - `anthropic.ts` 两条序列化路径入口用 `withoutProviderReasoning` 过滤（未知块会 throw）；
  - `openai.ts` 的 Chat convertMessages 显式丢弃，不告警；
  - md 导出不占位；
  - thinking-only 过滤（session-recovery、sidechain、findSplitThinking）改用 `isReasoningOnlyBlock`，把新块型算作非实质。
- token 估算：新块型按 0 计。
- 开关与能力位（`llm/reasoning-replay.ts`）：
  - `SID_CODE_RESPONSES_REASONING_REPLAY=0` 关闭回放，A3 的 A/B 实验用；
  - 回放后吃到错误体指向 reasoning 的 400，就标记该 (endpoint, model) 不再回放，一次性 warn，`/status` 显示「推理链回放: 网关不支持」。

## 放弃了什么（以及为什么不选）

- **复用 `redacted_thinking`**：anthropic.ts 会把它原样发给 Anthropic，「gpt → claude」中途切模型就 400；还要在约 20 个识别它的文件里逐个加守卫。新块型让旧路径天然不认识它。
- **加 `include:["reasoning.encrypted_content"]`**：store:false 下服务端默认已下发密文（前置探针 r1 没带 include 也拿到了 1252 字节），include 只是兼容旧值。
- **token 按密文长度估**：每轮累加几 KB base64，1300 轮会把 masking/压缩提前触发，正好撞上发现 3/4 的区域。官方说明旧轮 reasoning 不会渲染进新采样。
- **能力位落盘**：要改 provider 能力缓存的 schema。目前只有一个网关且探针证实它支持，进程内存够用；代价是新进程最多再吃一次 400（漏斗重试时已经不带回放）。
- **任何 400 都判「不支持」**：上下文溢出、参数非法也是 400。一律关掉会让一次偶发错误永久切断推理链，判据收窄到错误体含 reasoning / encrypted_content / item not found。

## 拿什么证明它生效了

- `responses-reasoning-replay.test.ts` 13 pass，覆盖：流式/非流式捕获、主循环/子循环 stream-processor 保留、回放位置、跨模型与开关丢弃、anthropic/chat 不带出、token=0、zod 闭集、能力位判据。
- 变异自证 4 处，各自对应的断言变红，恢复后全绿：
  - 解析器不捕获；
  - 不判跨模型；
  - token 按密文估；
  - 400 判据放宽到任意状态码。
- `affected-tests:run`（587 个文件）7072 pass / 0 fail；含 `redacted_thinking` / `buildResponsesRequest` / `parseResponsesBody` 字面量的跨域测试加 cli command 测试共 872 pass。
- `make build` 自检通过，无 `will always be undefined`；lint / format:check / typecheck:gate / lint:boundary / lint:command-system 全绿。参考页已重新生成（env.md 新增开关）。
- 端到端与效果：wire 层确认见 PR 正文；「回放 ⇒ 少返工」的因果由 A3 的 A/B 判定，**本 Note 不声称效果**。
