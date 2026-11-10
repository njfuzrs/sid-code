---
Status: implemented
Date: 2026-11-10
---
# 子代理的 LSP 诊断与 todo 回注改走 transient reminder 通道

## 决定了什么

`agent/agentic-loop.ts` 里两处 `ctxMgr.addMessage({ role: "user" })` 改成收集进一个
`reminderParts: string[]`，在发送前经**一次** `injectReminders(messagesForSend, { ambient })`
注入成带 `transient: true` 的 block：

1. **LSP 诊断**（原 `ctxMgr.addMessage`，台账 P1）；
2. **todo 清单周期性回注**（同一范式，台账未记，本次一并改）。

两处文案与围栏一字未动（`<system-reminder>` + 「非用户输入」声明保留），改的只是承载通道。
`reminder-inject.ts` 文件头的「不变量 3」原话是：

> **注入产物只进发送副本，永不写回 ctxMgr**。`reactive-compact.ts` / `auto-compact.ts` /
> `history-adapter.ts` 三处都靠这个前提才安全。

同一份注释在 `reminder-inject.ts:40` 点名了具体成员：「每轮重新计算的内容（todo、上下文压力、
权限模式、**诊断**…）仍然是 transient」。子代理这两处与主循环（`query/loop.ts` 的 G1 / P0-2）
消费同样的内容却不走同样的通道，是这条不变量唯一被绕开的地方。

顺带把 deferred-tools 的**降级路径**（末条非 user 时的 fallback）也改成往 `reminderParts`
里塞，因为 `injectReminders` 一个回合只许调一次（分档顺序由单次调用内的 splice 决定）。

## 放弃了什么（以及为什么不选）

- **只加围栏、不动通道**（现状正是如此，`lsp-injection-and-gating.test.ts` 的 D4 就是那次
  修复的遗留）。围栏解决的是「模型分不清谁在说话」（2026-07-29 事故），与「写不写历史」是
  两件事。实测这条通道错了也全绿——D4 是源码字面量扫描，只锁文案形态。
- **把诊断改成就地覆盖上一条同角色消息**（`ctxMgr.setMessages` 替换）。历史仍会永久留一份
  诊断文本，只是不新增条目，token 账没有变化，且引入「哪条该被覆盖」的新判据。
- **给子代理也接一套 reminder 节流/去重机制**（照搬主循环 `reminder-throttle.ts`）。子代理是
  单次派活、一条用户消息、生命周期以轮计，那套机器搬过来大半是空转（`agentic-loop.ts` 里
  P1-3 的注释已有同样的判断）。
- **等 `affected-tests` 全绿再交**：剩下的 1 个失败是 worktree 环境成因（见下），不是本次改动
  引入的，也没有可修的东西——它是「进程 cwd 在 worktree 内 → 隔离提示必然出现」的测试环境
  假设，CI 在真实 checkout 上跑不会命中。
- **顺手把 `readSubAgentTodos` 的调用点也换成 `tools.get` 的缓存版本**：与 P1 无关的优化，
  按铁律不塞进这个 PR。

## 拿什么证明它生效了

**新增** `packages/core/tests/agent/agentic-loop-injection-transient.test.ts`（6 条）：
驱动真实 `runAgentLoop`，用 mock provider 记录**每一次实际发出**的 `SendParams`，断言
todo 回注 ① 出现在发送副本里、② 不出现在 `ctxMgr.getMessages()` 里、③ 块上带
`transient: true`；加三条源码哨兵锁住「这两段不许再出现 `ctxMgr.addMessage`」与
「`injectReminders` 只许调用一次」。

**变异自证**（改坏 → 看红的是哪一条 → 恢复 → 回绿）：

1. 把 todo 回注改回 `ctxMgr.addMessage(...)` → **3 红**：`回注不出现在 ctxMgr 历史里`、
   `回注块带 transient: true`（`Received: undefined`）、`todo 回注段不得写回 ctxMgr`。
2. 把 LSP 诊断段改回 `ctxMgr.addMessage(...)` → **1 红**：`LSP 诊断段不得写回 ctxMgr`
   （`Expected to not contain: "ctxMgr.addMessage"`）。

**修改既有测试** `packages/core/tests/agent/subagent-todo-loop-mechanisms.test.ts`（3 处）：
这几条原本断言「回注出现在 `result.messages`（历史）里」，与本次契约变更直接冲突。按新契约
把断言位置移到 `flattenSentText(calls)`（实际发出去的副本），并补一条「历史里不含」。
其中两条原本是 `expect(history).not.toContain(...)`——改通道后它们会**恒真**（历史里永远不会有），
必须一并移到发送副本上，否则等于把门禁做成摆设。

**验收结果**：

- `bun run affected-tests:run` → **684 pass / 1 fail**（`./packages/core/tests/agent/`，75 文件）。
  唯一失败 `isolated-subagent-cwd.test.ts` 的「未绑定 cwd 时不出现隔离提示」三条举证：
  ① 该文件对 `agentic-loop` 的引用数 = **0**（`grep -c` 实测）；
  ② 在父仓单跑该文件 **12 pass / 0 fail**；
  ③ 成因是 `getIsolatedWorktree()` 读 `cwdStorage` 里进入时绑定的 root
  （`bootstrap/cwd-context.ts:66-77`），而 worktree 里的进程 cwd 就在 worktree 根下，
  所以系统提示必然带【隔离环境提示】——测试的「主仓行为不变」假设只在主仓 checkout 成立。
- `make build` 成功，产物自检 5 项全过（含 skill 内联、ripgrep 平台匹配）。
- `bun run lint` 0 warnings / 0 errors；`format:check` 通过；`lint:boundary`、
  `lint:command-system`、`lint:legacy-tool`、`typecheck:gate`（62 / 基线 64，无新增）全过。
- 端口/参考页未受影响（改动不涉及 `help.ts` / `cli.ts` / `tool/` / `command/` / `config/` / `hook/`）。

**未覆盖**：LSP 诊断那条只有源码哨兵，没有端到端行为断言——`collectDiagnosticText` 依赖真实
language server 推 `publishDiagnostics`，在单测里造不出稳定输入。它走的是与 todo 回注**同一条**
`reminderParts → injectReminders` 通道，行为面由后者的三条断言间接覆盖。
