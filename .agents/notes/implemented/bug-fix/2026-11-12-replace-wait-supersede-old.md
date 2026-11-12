---
Status: implemented
Date: 2026-11-12
Source: 收尾阶段重复挂监听·修复与验收方案（2026-11-12）
---
# 换了等法时淘汰盯同一对象的旧等待

## 决定了什么

R2 的 `decideWaitAdmission` 会判出 `replace`（同对象、换了等法），但 R2 只判定不执行：
新的照常起，旧的继续跑到自己的期限。结果是 ca8d7e5c 的形态——11:04:51 起一个只等 MERGED
的 shell，11:05:51 换去盯日志再起一个，两条等待并行；旧任务到期后再送一条 killed 通知，
模型（R3）把它误读成「PR 有了新结果」，回去前台重查。

R6 把 `replace` 从「建议」变成「执行」，三处改动：

1. **淘汰旧等待**（`packages/core/src/task/wait-admission.ts` 的 `supersedeReplacedWaits`）：
   三个入口（bash / monitor / schedule_wakeup）在 `replace` 时**先起新的、再停旧的**；
   shell 走 `killShellTask`、monitor 走 `killMonitorTask`、唤醒走 `getScheduler().removeTask`
   + `releaseWait(id, "superseded")`（与 `cron_delete` 同一条路径）。回执写明
   「已替换此前在盯同一对象的等待：<旧 id>（<旧描述>）」。
2. **被替换的旧任务不送终态通知**：任务状态新增 `supersededBy`，替换路径在 kill **之前**
   写入；`enqueueTaskNotification` 见到该标记跳过终态通知（入队点是所有终态通知的唯一收口）。
   终态写入与轨迹照常——`TaskLifecycle{completed}` 带 `reason: "superseded"`，
   `WaitReleased` 带 `superseded`，审计里能分开「被替换」与「正常终态」。
3. **shell-deadline 成功终态也撤销同 subject 的唤醒**（`wait-registry.ts` 修法 3）：
   S2 原先只对 monitor 的成功终态生效；`releaseWait(terminal)` 的快照窗口扩到
   `kind === "shell" && promise.kind === "deadline"`，送达侧同一判据。
   ca8d7e5c 里 sg36n1dwy 若以 MERGED 退出，盯同一 PR 的唤醒本该自动撤掉。

## 放弃了什么（以及为什么不选）

- **不在各入口各写一份淘汰逻辑**：三个入口的判据已经在 `wait-admission.ts` 统一，
  淘汰再分散写一次，任一处漏掉就会让「只留一个新等待」在一条路径上失效，
  而那条路径不会有测试覆盖。淘汰与判定放在同一模块，回执文案也只有一份。
- **不顺带淘汰 agent / workflow**：它们是模型要等的**产出**，不是「等法」。
  「换了等法」不该顺手杀掉一个正在干活的子代理。显式 switch 穷尽处留了注释。
- **新等待是唤醒时不淘汰任何主动等待**（`supersedeReplacedWaits` 的 `newKind === "wakeup"`
  直接返回空）：唤醒的语义是「过一会儿回来看看」的兜底，天然与正在跑的 monitor / 后台等待
  **互补**。S2 的设计就是「monitor 盯对象 + 唤醒兜底，monitor 成功终态后撤销唤醒」；
  第一版无条件淘汰，把 `wakeup-invalidation-chain` 的真实入口用例跑红了——
  monitor 被 kill 后通知不入队，兜底唤醒反而永远撤不掉。反方向不受影响：
  新起 shell / monitor 仍淘汰旧的唤醒（方案 §R6 验收 2）。
- **不在 `releaseWait(terminal)` 里直接撤销唤醒**（S2 就否决过）：判据是
  「成功终态 **且通知已投递**」，通知没进上下文就撤销，一旦投递链路出问题，
  模型既不知道结果也不会再被叫醒（#642 的静默中断）。修法 3 沿用了送达侧驱动。
- **不把普通后台 shell 的退出也算「对象已终态」**：它跑完只说明这条命令结束了，
  不是「被等的对象给出了结论」。只收模型显式声明的 `deadline` 等待。
- **不在 kill 时改写已经入队的非终态通知**：替换瞬间旧 monitor 可能还有事件批次在飞，
  它们是运行中的观测，撤回会让轨迹与投递不一致。只跳过终态通知。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/task/wait-supersede.test.ts` → **9 pass / 0 fail**（新增）：
  验收 1（旧 shell 进 killed、`supersededBy` 指向新任务、等待表只剩新的、通知队列里没有旧任务）、
  验收 2（唤醒被后台循环替换，`WaitReleased{reason:"superseded"}`）、
  验收 3（shell-deadline exit 0 撤销唤醒 / exit 1 不撤销 / 普通后台 shell 不撤销）、
  边界（新等待是唤醒时不淘汰 monitor，保住 S2 的 monitor + 兜底组合）。
- `bun test ./packages/core/tests/task/wakeup-invalidation-chain.test.ts` → **6 pass / 0 fail**：
  S2 的既有真实入口用例（含「monitor 成功终态 + 唤醒兜底」）未被 R6 误伤。
- `bun run smoke replace-wait-same-subject` → **PASS（0.5s）**：2 个 shell 启动、
  1 条 `TaskLifecycle{completed, reason:"superseded"}`、**0 条** `delivered(killed)`、
  1 条 `delivered(completed)` 对照，回执含「已替换此前在盯同一对象的等待」与「不再送终态通知」。
- 变异自证（`bun run smoke:mutate replace-wait-same-subject`）：删掉 `killShellTask` 那一步 →
  用例红（`completed(superseded)` 消失）；删掉通知跳过 → 用例红（多一条 `delivered(killed)`）。
- `bun run typecheck:gate` → 无新增类型错误（62/62）。
