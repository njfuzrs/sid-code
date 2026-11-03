---
Status: implemented
Date: 2026-11-03
---
# worktree 切换不再重建 system 静态区：工作目录与 git 快照移出静态前缀

## 决定了什么

修的是 `docs-research/sid-code/bugfixes/todo/20261030-worktree切换重建system静态区-整段前缀作废.md`。
根因：工作目录写在 system 的静态核心区（`buildEnvironmentSection`），`enter_worktree` /
`exit_worktree` 触发 `onWorkspaceChange` → `rebuildSystemPrompt`，静态区第一段就变，
后面的 system、tools、全部历史跟着重算。轨迹实测 133 次 `system_static` 断裂里 104 次
紧跟 enter/exit_worktree，字符级浪费中位数 0.997。

四处改动：

1. **`buildEnvironmentSection` 只留会话内不变字段**（home / platform / OS Version / shell）。
   工作目录与「是否 git 仓库」一并移出（后者依赖 cwd，同源同因）。位置
   `packages/core/src/config/system-prompt.ts`。
2. **两者改由动态区下发**：`generateDateAttachment` 增加 `workingDir` 参数，输出
   `<working-directory>` 并与 `<current-date>` 同处一个附件（`attachments.ts`）。
   选同一个附件是因为两者同属「本轮会话环境事实」，拆开只多一次 push 与一次拼接。
3. **`onWorkspaceChange` 不再无条件重建**（`packages/cli/src/app.ts`
   `wireWorkspaceRuleReload`）：比较新旧 CLAUDE.md 正文，**内容真变了才重建**
   （否则模型拿着旧 worktree 的规则干活）；没变就只排队一条「工作目录已切换为 X」。
   该通知经 `Manager.recordWorkspaceNotice` 排队、`query/loop.ts` 消费，
   以**持久 reminder 块**写进消息尾部（transient 只活一轮，模型第 3 轮就忘了自己在
   worktree 里，回头往主仓写文件）。
4. **`gitStatus` 从 `stable` 改为 `dynamic`**。这块含 `git branch --show-current`，
   worktree 检出独立分支（main → worktree-xxx），留静态区等于每次进出 worktree 整条前缀作废。
5. **配套归因（文档 3.2）**：新增 `SystemRebuildTrigger` 与
   `SendMutationCause = ... | system_rebuild:<trigger>`，`rebuildSystemPrompt(trigger)`
   必填该参数并 `recordSendMutationCause`，随 `prefix_break.cause` 落盘。
   覆盖 6 个触发源：claude_md_reload（含 watcher 路径）/ critical_constraints /
   skill_reload / language / memory_reload / session_memory。

## 放弃了什么（以及为什么不选）

- **放弃「CLAUDE.md 变化也走追加 block」（文档 3.1 原文）**。文档写的是「规则内容有变化，
  同样作为追加 block 注入」。没有采纳：system 里仍留着旧 worktree 的 CLAUDE.md 全文，
  再追加一条「规则已变」的块，模型会同时看到两份冲突的规则。改为**内容变就重建**
  （归因 `claude_md_reload`）。workspace 与主仓通常检出同一份 CLAUDE.md（同一 commit），
  所以绝大多数切换仍然不重建 —— 收益保住了，正确性没有让位。
- **放弃「会话起点快照 / memoize」（CC 做法）**。静态区能彻底零变化，但它会让
  worktree 内的模型看到 `Current branch: main` —— 模型据此判断"我在 main 上"，
  然后提交到错的分支。给错的 branch 比多花 200 字符贵得多。
- **放弃「本次不动 gitStatus」**。文档把它列为「等 3.2 数据再定的调查项」，但这不是
  调查项：`git branch --show-current` 必然随 worktree 变化，不做它，验收第一条
  「worktree 切换后 system_static 断裂为 0」根本达不到。文档在这里低估了它和 3.1 的耦合。
- **放弃「冻结整个 system prompt」（CC 另一条路）**。worktree 切换后模型必须拿到新路径，
  否则文件工具会用错基准目录。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/config/worktree-switch-prefix-stable.test.ts` —— **7 pass / 0 fail**。
  其中核心一条：同一会话内 `workingDir` 从 `/repo/main-checkout` 换成
  `/repo/.sid-code/worktrees/feature-x`，`splitSystemByDynamicBoundary(prompt).staticContent`
  **逐字节相等**。这条如果只比较含 boundary 的整串会恒假（动态区本来就不同），
  所以显式切出 staticContent 再比。
- `bun test ./packages/core/tests/config/` —— **844 pass / 0 fail**。
- 选测全量（`./packages/cli/ ./packages/core/tests/{config,context,hook,query}/`）——
  **5243 pass / 9 skip / 0 fail**。
- `bun run lint` 0 error、`bun run format` 无改动、`bun run typecheck:gate`
  当前 64 处 / 基线 64 处（无新增）。
- `make build` 成功，产物自检 5 项全过（含 `git-status 快照锚点`）。

**未证明的部分（必须说清）**：验收里「修复后带 worktree 切换的会话里 `system_static`
断裂为 0」是**轨迹侧断言**，需要真实会话跑一轮才能验；本次只证明了「同一输入下静态区
字节不再随 cwd 变化」这半条（单测层），没有跑真实 worktree 会话取证。

两处契约变更同步修正了旧断言，都在测试里写了变更理由而不是悄悄改数字：
`attachments.test.ts`（gitStatus 期望 `stable` → `dynamic`）、
`context-p1-fixes.test.ts`（P1-8 那条原本明确写着「防后人把 git 改成 dynamic」，
补上了"为什么方向变了"的完整论证）。
