---
Status: implemented
Date: 2026-11-16
Source: 权限模式对齐 claude-code 缺陷修复与验收方案（2026-11-12）
---
# dontAsk 拒绝交互类工具，skip / -y 不再吞掉用户 ask 规则

## 决定了什么

修两条同形态的权限模式缺陷（方案 M7、M8），核心原则一条：**用户写下的意图不该被另一个放行口静默改写**。

1. **`Tool` 接口新增可选方法 `requiresUserInteraction?(): boolean`**（放在 `ToolCapabilityFields`，
   `Tool` 与 `LegacyTool` 共同继承，一处声明两边生效）。首批由 `ask_user_question` 声明 `true`。
2. **`enforceModeHardConstraint`（`check()` 出口总闸）新增 dontAsk 分支**：dontAsk +
   `requiresUserInteraction === true` 一律拒绝。出口位置是关键——allow 规则（Step 8）、
   会话记忆、预授权、hook allow 全都排在阶段二 dontAsk 判断之前，任何一条命中都会把
   问卷弹出来。改前 `dontAsk + allow ["AskUserQuestion"]` 实测 `allowed=true step=8-rule`。
3. **skip 档新增 `checkUserAskUnderSkip`**：`checkUserDenyUnderSkip` 只挡 deny 规则，
   用户写下的 `ask` 规则在 `--dangerously-skip-permissions` 下被静默执行。现在命中 ask
   规则时交互模式返回 `needsConfirmation`（走正常弹窗），无头模式直接 deny 并把规则原文
   写进 reason（skip 早退排在阶段二 headless 分支之前，走不到那个统一落点，所以在本地落一次）。
4. **`-y`（yesMode）分支排除 ask 规则**：抽 `isUserAskRule(reason)`，与 M1b 的
   `classifierMayApprove` 共用，避免 auto / yesMode / skip 三处各写一份判据而漏抄。

### 为什么用工具自报而不是工具名清单

`ask_user_question` 一个工具时名单也能用，但名单会漂：新增交互类工具的人不会知道
权限层有这份名单，也不会被任何门禁提醒。仓库里 `exemptFromLoopDetection`、
`needsPermissionChecker`、`requiresPermission` 都从死名单改成工具自报，这里是同一范式的延续。
`requiresPermission`（免权限）与 `requiresUserInteraction`（必须有人回答）是两个正交字段，
刻意不合并：`ask_user_question` 两个都不能声明成免检，否则 dontAsk 下会被 Step 13.6 放行。

## 放弃了什么（以及为什么不选）

- **不选「在 `checkAskRules` 里对 skip 早退做特判」**：`checkAskRules` 是 Step 5 的实现，
  在它里面塞模式判断会把「规则匹配」和「模式策略」耦合起来；放在 skip 分支自己身上，
  判据只影响 skip 档。
- **不选「无头 deny 完全交给 tool-executor」**：skip 早退在 checker 最前面，绕过了
  阶段二的 headless 分支，executor 拿到的是 `needsConfirmation`。虽然 executor 最终也会
  转 deny，但 `reason` 会丢失规则原文，模型改不动命令。本地落一次 deny 让文案带规则原文。
- **不选「给 skip 加个 `skipAskRules` 配置项让人自己关」**：等于把「ask 规则是否算安全底线」
  变成又一个可配开关，而这次修的就是「配置了 ask 却静默执行」的意外。要跳过就让用户删规则。
- **不选「把 `ask_user_question` 加进 `requiresPermission` 免权限清单」**：那是 B14 已明确
  排除的方向（它的语义是需要人，不是不需要权限），M7 修完后更不该回头。
- **未改无头 + 非 dontAsk 的 `ask_user_question` 行为**：工具自己返回 `unavailable`，
  已经是对的行为，权限层不重复拦一次。

## 拿什么证明它生效了

- **修前实测（main @ cb45b5d6，探针脚本）**：
  `dontAsk + allow ["AskUserQuestion"] → allowed=true step=8-rule`；
  `skip + ask ["Bash(git push*)"] + git push → allowed=true step=skip`；
  `yesMode + 同上 → allowed=true step=yes`。
- **修后 G1**：新增 `packages/core/tests/permission/m7-m8-user-interaction-and-ask-rules.test.ts`
  22 条全绿，覆盖：两条缺陷的核心回归、`ask_user_question` 的声明与不声明免权限、
  dontAsk 下四类放行口（allow 规则两种名字 / 会话记忆 / hook allow）、default 与 acceptEdits
  不误伤、skip 的复合命令与不误伤、deny 语义不变、yesMode 的危险命令护栏不变、
  无头路径 deny 且 reason 含规则原文、子代理继承 skip 后 ask 规则仍生效。
- **变异自证**（三处改坏，逐条跑测试后恢复）：
  `ask_user_question.requiresUserInteraction() → false` 让 6 条变红（含 dontAsk + allow）；
  删掉 skip 的 `checkUserAskUnderSkip` 调用让 2 条变红；
  去掉 yesMode 的 `isUserAskRule` 条件让 1 条变红。恢复后 22 pass / 0 fail。
- **G2**：新增 `tests/smoke/cases/X14-skip-respects-ask-rules`，`--dangerously-skip-permissions`
  + 项目级 `permissions.ask: ["Bash(git push*)"]`，断言 `PermissionDecision{outcome:deny}`
  1 次且 `PostToolUse` 0 次 —— 决策层拦住 **且工具真的没执行**（两条一起才排除「判了 deny
  但执行器照跑」）。`bun run scripts/smoke/run.ts X14-skip-respects-ask-rules` → PASS；
  `smoke:mutate` 同用例 → killed。
- **端到端（真实模型 + 真实 git 仓库）**：临时目录里 `git init` + 一个 bare 远端，
  项目级 settings 写 `{"permissions":{"ask":["Bash(git push*)"]}}`，用本 PR 构建的二进制跑
  `--trust-workspace --dangerously-skip-permissions -p "把当前分支 push 到 origin"`。输出：

  ```text
  以下 1 个操作在非交互模式下被拒绝（无 TUI 可确认，重试相同输入不会改变结果）：
    - bash(git push -u origin master 2>&1): 非交互模式下自动拒绝（skip 模式命中用户 ask 规则，
      无人可确认）：规则要求确认: bash (匹配 Bash(git push*))
  如需放行，用 --allowed-tools / --allow-tool 预授权，或 --permission-mode 调整权限模式。
  ```

  并且 `git -C remote.git log` 为空 —— 远端确实没收到提交，不是「判了 deny 但执行器照跑」。
- **既有回归**：`internal-tool-permission.test.ts` + `checker.test.ts` 100 pass / 0 fail。
