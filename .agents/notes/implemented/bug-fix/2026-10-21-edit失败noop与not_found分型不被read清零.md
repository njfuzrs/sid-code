---
Status: implemented
Date: 2026-10-21
---
# edit 失败按 noop / not_found 分型，这两类不被 read 清零，达阈值附实时片段

## 决定了什么

来源是会话 `20261020-110542-ce7ea52e` 评估的发现 9（PR F）。被评会话 456 次 edit 里 134 次失败，old==new 之后的下一步有 9 次又是 old==new。

- `tool/edit.ts`：old==new 的错误文案补一句「new_string 必须是改后的完整内容；想确认文件内容请用 read，不要用 old==new 的 edit 当探针」。原文案前缀「old_string 与 new_string 完全相同，没有需要修改的内容」保留，分型靠它识别。
- `query/edit-failure-tracker.ts`：
  - 新增 `classifyEditFailure`，分出 `noop / not_found / ambiguous / stale / oversize / other`。原 `classifyAdvice` 的关键词判定原样搬进来，没改口径。
  - 计数从 `number` 改为 `{count, sticky}`。`sticky` 记 noop / not_found 的条数。read 成功时 count 降回 sticky（只丢 read 能改正的那几类），sticky 只被该文件一次成功 edit/write 清零。
  - noop / not_found 达阈值时，按 old_string 里第一条在文件中出现、去空白后长度 ≥ 8 的行定位锚点，附上下各 8 行的实时内容（read 的 `行号\t内容` 格式）。找不到锚点不附，文件 > 2MB 不附。
- `query/tool-executor.ts`：把 `block.input.old_string` 传给 `recordEditOutcome`。

## 放弃了什么（以及为什么不选）

- **read 对所有类型都不清零**：stale（读后被改）和「未读」类失败，读一次就是正确的改正动作，不清零会让提醒在模型已经照做之后仍然升级。
- **sticky 类在 read 后完全不降**（即 read 对 count 无影响）：混合序列里 other 类的计数也会被 sticky 拖住，read 的自愈语义整个失效。改为「降回 sticky」，两类各自走各自的规则。
- **附整份文件 / 附 read 的完整输出**：大文件一次几万字符，提醒的成本比失败本身还高。8 行上下文足够做下一次 edit 的锚点。
- **用短行（`}`、`return;`）做锚点**：到处都是，会定位到无关位置，给模型错误的锚点比不给更糟。所以设了最短长度 8，测试锁住。
- **写主仓/重复失败时直接拦截 edit**：只改提示和分型，不改控制流，与原 tracker「纯追加、不阻断」的定位一致。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/edit-failure-tracker.test.ts`：24 pass / 0 fail（原 16 条 + 新 8 条）。新用例覆盖被评会话的原形态「old==new → read → old==new → read → old==new」第 3 次仍提醒、not_found 同样不被清零、混合序列只降回 sticky、成功 edit 清零 sticky、片段锚点与上下文边界、短行不当锚点、找不到锚点不附。
- 变异自证 6 处，均按预期变红：read 恢复为全清零（3 红）、noop 移出 sticky（2 红）、不附片段（1 红）、去掉最短锚点（1 红）、noop 不分型（3 红）。
- `grep -rnF '没有需要修改的内容' tests packages/*/tests`：0 命中，无跨域字面量断言。
- 未验证：下一次同模型会话的 edit is_error 比例（本次 134/456）。这需要真实会话，本 PR 没跑 sc-dev 端到端。
