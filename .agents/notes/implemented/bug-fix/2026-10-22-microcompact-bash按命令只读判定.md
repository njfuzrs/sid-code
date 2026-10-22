---
Status: implemented
Date: 2026-10-22
---
# microcompact 里 bash 按命令只读判定，写命令输出不再被完全清空

## 决定了什么

`packages/core/src/query/compact/microcompact.ts` 把 `bash` 从 `DISCARDABLE_TOOLS` 拿出来，改为按
`tool_use.input.command` 分类：`isReadOnlyCommand`（`tool/bash/read-only-validation.ts`，AST 级、
识别写入重定向）判为只读的才算可丢弃（旧输出完全清空）；其余（`git commit` / `rm` / `curl -X POST` /
`npm publish` / `git log > f`）按 edit/write 那一档保留前 200 字符摘要。拿不到命令时保守判为不可丢弃。

`isDiscardableTool` / `isNonDiscardableTool` 加了可选的 `input` 参数；`cached-microcompact.ts` 的
`CachedToolState` 记下 `input`，cache_edits 删除名单走同一判据（生产路径 `query/loop.ts` 默认开启
`emitCacheEdits`，不同步的话写命令输出仍会被服务端删掉）。

起因是术语表核验（缺陷文档 D3）：旧注释的前提是「这些工具的输出都能靠重新执行找回」，对写命令不成立，
重跑就是重复副作用。同 PR 顺带修了 D1（4 处「DeepSeek 只认 high/max」过期注释，实际认 low/high/max）和
D2（microcompact 文件头把「未分类工具原样保留」写成了「保守清空」）。

## 放弃了什么（以及为什么不选）

- **bash 整体降级到不可丢弃**：改动最小，但只读命令的大输出（测试日志、`cat`）也只能留 200 字符，
  省下的上下文变少，牺牲「更省」却换不来更多安全。
- **保持清空、只在占位符里加副作用警告**：把判断推给模型，模型想回看提交信息时依然只能重跑，
  没有解决问题本身。
- **复用 `permission/bash-classifier.ts`**：缺陷文档建议过它，但它是调 LLM 的分类器，
  不能在每轮发送前的同步压缩路径里调。

与 claude-code 的差异是有意的：它的 `COMPACTABLE_TOOLS`（`services/compact/microCompact.ts:41`）
对 shell 一律清空。这里比它保守，代价是写命令的旧输出每条多留约 200 字符。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/query/compact/`：82 pass / 0 fail。新增用例覆盖 5 条写命令判为
  不可丢弃、拿不到命令时保守处理、写命令输出在 time/cache 两种模式下都保留 200 字符摘要、
  cache_edits 名单不收写命令。
- 变异自证：把 `isReadOnlyBashInput` 改成恒返回 true，3 条新断言变红（79 pass / 3 fail），恢复后全绿。
- 旧用例里 bash 的 `input: {}` 改成带只读命令，属于契约变更导致的测试前提修正，不是放宽断言。
