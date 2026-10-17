---
Status: implemented
Date: 2026-10-17
---
# 工具输入 `activeForm` 别名在校验边界归一（S2 / PR-2）

## 决定了什么

- `validateToolInput` 的第一步改为 `normalizeInputAliases`（新文件 `tool/input-alias.ts`），之后才做 null 回填、数字回填和 `safeParse`。它按 zod schema 结构递归处理，能进到 `todos[]` 这类嵌套里。
- 只认登记过的那一对 `activeForm → active_form`：shape 声明了 `active_form`、没声明 `activeForm` 时才改名。两个键同时出现时保留 `active_form`，丢弃别名，并记一次 `dropped`。覆盖 `todo_write`、`structured-task-create`、`structured-task-update`。
- 每次命中都落一条度量事件 `ToolInputAliasApplied{tool, from, to, count, dropped}`，用来看还有没有别的 camel/snake 漂移。等有数据再决定要不要泛化。
- 对模型暴露的 JSON schema、内部 `TodoItem.activeForm`、`findNearMissKey` 的打回文案都不动。

## 放弃了什么（以及为什么不选）

- **zod preprocess 做别名**：schema 会变成 `pipe`，`nullish-normalize` 和 `numeric-coerce` 的拆包识别不了。strict 模式下 `active_form:null` 原本会被剥成缺省，用了 preprocess 后会直接校验失败，structured-task 会因此退步。
- **把 `activeForm` 定为协议字段名**：协议层统一用 snake_case，容错只放在边界做。
- **改打回文案**：全库 12 个失败会话的文案里都已经点名了正确字段，问题出在首次调用就失败，不在文案。
- **通用 camel↔snake 自动匹配**：还没有数据，提前泛化会误改合法字段。先度量。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/tool/input-alias.test.ts`：10 pass，用的是三个工具的真实 zodSchema。覆盖事故形态首次调用即成功、两键同传取 `active_form`、`active_form:null` 和 `activeForm:null` 仍被剥成缺省、真漏传仍被打回、规范输入不发事件。
- 变异自证：让 `normalizeInputAliases` 原样返回，4 条用例红；恢复后 10/10 绿。
- `bun test ./packages/core/tests/tool/`：1120 pass / 0 fail。其中 `input-validator-self-recovery` 有 2 条旧用例原本断言「`activeForm` 必须被打回」，和本次目标矛盾，已改成断言归一后通过；改名文案改由未登记的变体 `ActiveForm` 继续守护。
- **真实会话判据（合并后观察）**：`todo_write` 校验失败的会话数从 12/251 降到 0；`ToolInputAliasApplied` 事件计数。
