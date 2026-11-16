---
Status: implemented
Date: 2026-11-16
Source: 工具接口设计：剩余项 T1 / T2 / T4 / T5（2026-11-15）
---
# 给 task / lsp / ask_user_question 补 5 对 CC camelCase 别名

## 决定了什么

T4 字段名盘点（41 个 sid-code 内置工具 × 53 个 CC 工具目录）查出 **5 个「同一概念、
拼法不同」且别名层未覆盖**的字段，把它们登记进
`packages/core/src/tool/input-alias.ts` 的 `ALIASES`：

| sid 工具 | 协议字段（snake） | CC 字段（camel） | CC 出处 |
|---|---|---|---|
| `task_get` / `task_update` | `task_id` | `taskId` | `TaskGetTool.ts:15`、`TaskUpdateTool.ts:38` |
| `task_update` | `add_blocks` | `addBlocks` | `TaskUpdateTool.ts:50` |
| `task_update` | `add_blocked_by` | `addBlockedBy` | `TaskUpdateTool.ts:56` |
| `lsp` | `file_path` | `filePath` | `LSPTool/schemas.ts`（每个 discriminated union 分支） |
| `ask_user_question` | `questions[].multi_select` | `questions[].multiSelect` | `AskUserQuestionTool.tsx` 的 `questionSchema` |

只动容错层，**不动任何工具的 zod schema**：对模型暴露的 JSON schema 不变，协议层仍是
snake_case，容错发生在校验边界之前（与 `activeForm`、grep 短参数同一机制）。

`multi_select` 是嵌套字段，靠 `walk()` 的逐字段下钻命中，路径与 `todos[].activeForm` 相同。

## 放弃了什么（以及为什么不选）

- **把 sid schema 改成 camelCase**：否决。CC 自己就不统一——`TaskGetTool` / `TaskUpdateTool`
  用 `taskId`，而 `TaskStopTool` / `TaskOutputTool` 用 `task_id`（`TaskStopTool.ts:13`）。
  也就是说「对齐 CC」这个目标本身有两个互斥的答案，改 schema 只能堵住一半，
  另一半仍然靠别名。而 sid 的 `read` / `edit` / `write` / `notebook_edit` 全是 `file_path`，
  单把 `lsp` 改成 `filePath` 会在协议层开一个口子。
- **不加，等 `ToolInputUnknownKeys` 用量证据**：否决。这 5 对不是猜测的命名风格漂移，
  而是 CC 的**协议先验**——CC 的字段名就是这个。`input-alias.ts` 对 grep 短参数已经
  立过同一口径（「跨产品协议先验，不是猜测的命名风格漂移，所以直接登记」），
  两条规则不该对同一类事实给出不同结论。
- **泛化成「camelCase 归一化后相等就改名」**：否决。会让任意工具的任意键都可能被悄悄
  改写，每一对别名就失去了「有具体出处」这个约束。范围仍收窄在显式登记表内。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/tool/input-alias.test.ts` → **28 pass / 0 fail**
  （新增 6 条用例：task_get、task_update 三条一次全改、lsp、ask_user_question 嵌套、
  两键并存记 dropped、不误伤 glob）。
- **变异自证**：注释掉 `{ from: "filePath", to: "file_path" }` 后重跑，
  `lsp：filePath → file_path` 变红（27 pass / 1 fail）；恢复后回绿。证明用例守的是真实逻辑，
  不是恒绿摆设。
- `bun run affected-tests:run` → **1622 pass / 0 fail**（108 files）。
- `make build` 成功，产物自检四项全过。
- `bun run docs:gen-reference --check` → 参考页与源码一致（别名不改 schema，预期无漂移）。
- `bun run lint` → 0 warnings / 0 errors；`bun run format:check` 通过。
