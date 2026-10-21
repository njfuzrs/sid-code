---
Status: implemented
Date: 2026-10-21
---
# compact_boundary 尾部为 user 时并入那条消息；发送前校验增量化并按签名去重

## 决定了什么

来源是会话 `20261020-110542-ce7ea52e` 评估的发现 11（PR C2）。被评会话里 `ROLE_NOT_ALTERNATING` 告警 897 次。原因有两个：边界是裸 push 的 user 消息，尾部恒为 user[tool_result]，于是出现 user,user 相邻；`getCleanedMessages` 两个出口每轮都对全量历史跑一遍 validate，同一问题每轮重报。

- `context/manager.ts` `addCompactBoundary`：
  - 尾部是 user 时，`[压缩边界]` text 块追加进那条消息，`_meta.compact_boundary` 合到它身上，不新增消息。
  - 尾部换成新对象，不原地改：`restoreToPrefix` 和发送快照靠引用相等判断前缀有没有被改写。
  - 合并后的消息**不打顶层 `compact_source`**。否则一条真实的 tool_result 消息会被 `isCompactSourceMessage` 当成压缩产物，P0-5 守卫会提前生效。来源记在 `compact_boundary.source`。
  - 尾部不是 user 时维持原行为。
- `context/validator.ts`：`validate(messages, { from })`，逐条规则只看 `[from, n)`。交替检查仍看 `from` 前一条；tool_use id 仍从整个数组收集，避免前缀里的 tool_use 被新 tool_result 误报 MISMATCH。不传 `from` 时行为不变（另两处调用方 `:2061`、`:2485` 不受影响）。
- `manager.ts` 新增 `validateSendCopy`：按引用取与上次已校验历史的最长公共前缀作为 `from`，`(code, messageIndex | message)` 签名只告警一次。`resetLocalCompactState` 一并清空游标和去重集。

与 PR C 3a 的口径不冲突：hard 路径的 `msgCountAfter` 在插边界之前取，blocking/emergency 用 `truncated.messageCountAfter`，边界并入不改变任何「压缩成没成功」的判定。

下游已核：snip（`query/compact/snip-compact.ts`）对 `messages[0]` 同时认 `_meta.compact_boundary` 和 `[压缩边界]` 前缀，两者合并后都在；TUI `history-adapter.ts` 对混合内容只剥掉 `[压缩边界]` 文本块，tool_result 照常渲染。

## 放弃了什么（以及为什么不选）

- **走 `addMessage` 合并**：它对内部 origin 会补桥消息（反而多两条），还会对合并内容重跑聚合预算。
- **合并消息也打 `compact_source`**：见上，会把真实 tool_result 消息误判为压缩产物。
- **校验器全局按签名去重、不做增量**：每轮仍要遍历全量历史，开销不降；而且签名里的 messageIndex 在压缩后会复用，不清空会吞掉压缩后的新问题，所以游标和去重集要一起随重置清空。
- **删掉 `compactBoundaryBreaksAlternation`**：它现在是并入分支的判据，`learned-window-followups.test.ts:259` 也在测它，保留。

## 拿什么证明它生效了

- 新增 `packages/core/tests/context/compact-boundary-merge.test.ts` 12 条：尾部 user 时不新增消息、validate 0 错误、`_meta` 在尾部 user 上；合并消息不被当成压缩产物；边界在下标 0 时 snipCompact 跳过它；尾部 assistant 时原行为；尾部替换为新对象；同一问题只告警一次；游标回退后同签名仍不重复；新问题照样告警；第二次调用 `from` 等于已校验前缀长度；整体替换后可再报；`validate({from})` 两条。
- `meta-preservation.test.ts` 一条用例改为先补 assistant，让边界独立成条（原用例的前提「边界后面有可释放前缀」在并入后不成立）。
- context、query/compact、false-compaction-banner、learned-window-followups、session-memory、sdk、cli history-adapter：568 pass / 0 fail；`./packages/core/tests/query` 全目录 888 pass / 0 fail。
- 变异自证 9 处均变红：去掉并入（3 红）、合并消息打 `compact_source`、原地改尾部、去掉去重、`from` 恒为 0、重置不清去重集、tool_result 检查不看 `from`、tool_use 只收 `from` 之后、交替检查从 1 开始（各 1 红）。其中「去掉去重」第一版测试 0 红，补了「尾部被合并替换后游标回退」用例才抓到。
- 未验证：长会话里告警计数的真实下降（需 sc-dev 端到端）；anthropic 路径 wire 上的行为（本次结构上已不再产生 user,user，但未抓包）。
