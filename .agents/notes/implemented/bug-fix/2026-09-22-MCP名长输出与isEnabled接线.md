---
Status: implemented
Date: 2026-09-22
---
# MCP 全名截 64、CJK 输出按 token 截、isEnabled 接到发 schema 的入口

来源：`docs-research/sid-code/bugfixes/todo/20260920-工具调用层-写入门文档时核出的缺陷.md` 的 D4 / D5 / D7。文档写「D4+D5 可并行、D7 单独」；同一次审计、同一次交付，合一个 PR。

## 决定了什么

1. **D4** `buildMcpToolName` 对最终全名按两段分预算（前缀 5 + 分隔 2 后剩 57），保证匹配 `^[a-zA-Z0-9_-]{1,64}$`，且 `parseMcpToolName` 仍能拆出两段。斜杠命令 `mcp__server__prompt` 改调同一函数，不再手拼。
2. **D5** `enforceMcpOutputTokenLimit` 快路径改按最坏系数 `NON_ASCII_TOKENS_PER_CHAR=0.65`：`len × 0.65 ≤ maxTokens` 才跳过估算。超限按 token 预算切前缀，不再按 `maxTokens × 4` 切字符。系数从 `token-estimator.ts` 导出，删掉平行的 `CHARS_PER_TOKEN = 4`。
3. **D7** `isEnabled` 接到真正发 schema 的入口：`toDefinitions` / `activeDefinitions` / `definitionsForTools` / `searchDeferredTools` / `deferredToolNames` / `enabled()`。`assembleToolPool` 也滤（文档要求的那一处），但生产 `definitions()` 无 options 时走 `all()`，只接 assemble 是死接线。系统提示词与 SDK `listTools` 改走 `enabled()`。`--dump-tools` 开 `includeDisabled`：dump 发生在 `initializeLSP` 之前，CI 零 language server，默认过滤会让参考页丢掉 `lsp`。`toLegacyTool` 透传 `isEnabled`。`LegacyTool` 补上可选 `isEnabled()`。

## 放弃了什么（以及为什么不选）

- **D4 只对最终串 `slice(0, 64)`**：会切掉第二个 `__`，`parseMcpToolName` 拆不出 tool 段。权限规则 / tool_search 按 `mcp__server__*` 匹配会静默失效。
- **D5 继续对齐 CC 的「字符数 × 0.5」快路径**：那正是缺陷本身。仓规中文一等公民，启发式按英文设计会把超限 30% 的汉字标成没超。
- **D7 只在 `assembleToolPool` 过滤**（文档建议）：生产路径 `loop.ts` / `agentic-loop.ts` / `app.ts` 调 `definitions()` 都不传 options，assemble 那层过滤零调用。这是同一份文档刚报过的死接线形态，不能再做一次。
- **D7 不注册 isEnabled=false 的工具**：LSP 在 pending 时要早可见、success 后可能变 false，注册时裁掉就再也回不来。执行器 `get()` 仍要能找到它，否则模型盲调变成「工具未找到」而不是「当前不可用」。
- **把 dump-tools 也走 isEnabled 过滤**：参考页会随机器 LSP 有无漂，pre-commit `--check` 在开发机和 CI 结论相反。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/mcp/normalization.test.ts ./packages/core/tests/mcp/mcp-output-limit.test.ts ./packages/core/tests/tool/registry.test.ts ./packages/core/tests/tool/registry-modernization.test.ts ./packages/core/tests/lsp/lsp-injection-and-gating.test.ts ./tests/website/gen-reference.test.ts` → **112 pass / 0 fail**
  - D4：两段各 80 → 全名 ≤ 64 且 parse 出两段
  - D5：「中」×50000 / ×60000 截完正文 `estimateText ≤ 25000`（复现原文的那组输入）
  - D7：`isEnabled: () => false` 不进 `definitions()`；零 server 的 LSPTool 不进 `definitions()`；`includeDisabled` 仍含它
- `bun run affected-tests:run` → **5823 pass / 0 fail**（369 files）
- `make build` / `bun run lint` / `format:check` / `lint:boundary` 见 PR 正文
