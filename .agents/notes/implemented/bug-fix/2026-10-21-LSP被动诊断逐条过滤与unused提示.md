---
Status: implemented
Date: 2026-10-21
---
# LSP 被动诊断逐条过滤 Hint/Info，codeAction 的 unused quickfix 附「可能尚未接线」说明

## 决定了什么

来源：评估会话 20261020-110542-ce7ea52e 发现 7。

- `lsp/manager.ts` 的 `collectDiagnosticText`：旧实现只判「整批是否含 Error/Warning」，过关后把同文件的 Hint 原样带出。现在**逐条**过滤，只保留 Error/Warning；一个文件过滤后一条不剩则整段不出现；末尾附一行「另有 N 条提示（Hint/Info）已省略」，模型需要时可用 lsp 工具主动查全量。过滤后整批为空仍返回 `null`（保持「有真问题才打扰」）。
- `tool/lsp-formatters.ts` 的 `formatCodeActions`：quickfix 标题匹配 `/\bunused\b|never (?:read|used)|未使用/i` 时附一行「注意：unused 可能只是尚未接线。删除前确认该成员是否属于本次设计」。

起因：该会话 120 次被动注入里 606 条 Hint（其中 497 条是无关的 deprecated 提示）混在 443 条 Error 中；模型照着 `Remove unused` 删掉了本次设计里尚未接线的成员，随后又加回来，形成振荡。

## 放弃了什么（以及为什么不选）

- **只改整批判据，不改逐条**：Hint 仍会随同文件的 Error 一起带出，正是现场的形态。
- **按文件过滤**：同文件里 1 条 Error + 5 条 Hint 时仍会带出 5 条 Hint。
- **彻底不显示被省略的条数**：模型会以为「没有别的诊断」；一行计数成本极低，且给了主动查询的入口。
- **屏蔽 unused 类 quickfix**：unused 在多数情况下是真问题，屏蔽会丢掉有用的信息；只加说明、不删选项。
- 代价：Hint 里偶尔有真有用的（如 unused import）被省略。这牺牲「更准」换「更省」，由「已省略 N 条」+ 主动 lsp 查询兜底。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/lsp/`：新增「1 Error + 5 Hint ⇒ 只出 1 行诊断 + 省略说明」「跨文件：只含 Hint 的文件整段不出现」「unused quickfix 附说明、其它不附」。
- **变异自证**：把逐条过滤恢复成旧的整批放行，两条新断言变红；恢复后 138/138 绿（提交 `4dc4454f` 时记录）。
- 随 D2 同分支跑 `affected-tests:run`：6084 pass / 0 fail，覆盖 `packages/core/tests/lsp/`。
- 未验证：没有在真实会话里复测 Hint 注入量下降；评估会话的 606 条是回溯数据，不是修复后的对照。
