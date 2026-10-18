---
Status: implemented
Date: 2026-10-17
---
# 子代理文档：把自定义 agent frontmatter 字段表按代码事实收窄

## 决定了什么

修 `website/extend/subagents.md` 的自定义 agent frontmatter 字段表与示例，使其与代码事实一致：

- 字段表删掉 `modelTier`、`maxTurns` 两行，并补一句「这两个字段只对内置 agent 生效，自定义 agent 写了会被静默忽略，想分级用 `model` 字段」。
- 自定义 agent 示例 frontmatter 去掉 `modelTier: cheap`（照抄会被静默忽略）。
- 顺手修 3 处失准：`description` 由「必填」改为「建议必填」（代码无强制校验，`custom.ts:176` 兜底空串）；explore 工具清单补「等」（实际还有 `task_list`/`task_get`，`agent-definition.ts:100`）；后台子代理的 abort 语义补全（ESC 不转发给后台子代理，`tool.ts:126-139`）。

`modelTier`/`maxTurns` 对自定义 agent 是否该补代码支持，属产品决策，方案文档落在 docs-research，**不在本 PR**。

## 放弃了什么（以及为什么不选）

- **在同一 PR 里补代码让两个字段对自定义 agent 生效**：不选。那是产品决策（是否给自定义 agent 开 per-agent 模型分级/轮次上限的粒度），需要先拍板，且改动横跨 custom.ts / agent-definition.ts / cli.ts / sub-agent.ts 四个文件。把它和「文档错了先修文档」绑在一起，会让文档的正确性修复被代码决策拖住。文档先行收窄，代码决策走 docs-research 方案。
- **保留 `modelTier`/`maxTurns` 两行、只加一句「暂不支持」**：不选。字段表是用户照抄的入口，留两行写着会被静默吞掉的字段，比删掉更容易误导。删掉 + 一句指向 `model` 字段是更干净的收口。

## 拿什么证明它生效了

- 核查方法：派 4 个 explore 子代理分域核查，关键不符点由主代理亲自读码复核——`grep modelTier|maxTurns packages/core/src/agent/custom.ts` 仅命中 281 行一行注释、无解析分支；`cli.ts:2023-2039` 透传链逐一核对 9 个字段无这两个；`sub-agent.ts:247-248` `resolveSubAgentMaxTurns` 只认 `task.maxTurns`。
- 文档改动后 `git diff` 逐处核对，5 处改动与结论一一对应（字段表删 2 行 + 示例去 1 行 + description 措辞 + explore 工具 + abort 语义）。
- 本 PR 为纯 `website/` 文档改动，`affected-tests` 判定见 PR 正文；`make build` 通过。
