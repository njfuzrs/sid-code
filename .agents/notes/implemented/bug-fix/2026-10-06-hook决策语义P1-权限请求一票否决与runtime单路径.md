---
Status: implemented
Date: 2026-10-06
---
# Hook P1：PermissionRequest 一票否决、runtime hook 只走一条路、cwd 不拼进命令串、stderr 不当 JSON

## 决定了什么

对应 9-27 缺陷文档的 H2 / H3 / H6 / H7 / H14 / H16，一个 PR：

- **H2**（`hook/aggregator.ts`）：`PermissionRequest` 进 OR 合并分支。原先落在 `mergeSimple`（last-wins），后一个 hook 的 allow 盖掉前一个的 deny。
- **H3**（`hook/types.ts` + `aggregator.ts`）：`createHookOutput` 让 `PermissionRequest` 建 `PreToolUseHookOutput`，认 `permissionDecision`。aggregator 里另抄的一份「事件→子类」映射删掉，直接复用 `createHookOutput`——两份映射各自维护正是 H3 的成因。
- **H6 / H7**（`hook/event-handler.ts`）：删掉「全是 runtime hook 就直接 `await action(input)`」的快速路径，runtime hook 一律走 `runner.executeRuntimeHook`。返回值（含 deny）、timeout、AbortSignal、异常隔离、耗时随之恢复（H8 / H9 同源，顺带修掉）。
- **H14**（`hook/runner.ts`）：删掉 `expandCommand`，命令串原样交给 `sh -c`。`$SID_CODE_PROJECT_DIR` 本来就在环境变量里；`$SID_CODE_CWD` 原先只靠字符串替换提供，补进环境变量，写法兼容。
- **H16**（`hook/runner.ts`）：只从 stdout 解析 JSON，stderr 从不当 JSON（对齐 CC）。stderr 仍作 exit 2 的阻塞理由和其余非零的告警文本。

## 放弃了什么（以及为什么不选）

- **H14 给 cwd 做 shell 转义**：否决。转义得对每种 shell 元字符都对，且仍是往命令串拼值；环境变量路径不经二次解析，天然安全，替换函数纯冗余。删函数后的结构性断言（源码零命中 `expandCommand`）比行为断言更能防复发。
- **H6 保留快速路径、在里面补 timeout / 返回值**：否决。那等于在旁路上重写一遍 `executeRuntimeHook`，两条路径还会再分叉。快速路径省下的只是一次 aggregator 对象构造，内部 runtime hook（trace / telemetry / session-metrics）全是可观测组件，最不该丢超时保护。
- **H16 保留 stderr JSON 兜底但要求含决策字段**：否决。CC 明确只认 stdout；保留兜底等于继续让子命令的 stderr 日志左右决策。兼容代价：把 JSON 写在 stderr 的用户 hook 不再生效——这与 CC 用户的预期一致。
- **H17 / H18（JSON 形状校验、async 挂阻塞事件告警）**：不在本次范围，未动。

## 拿什么证明它生效了

- 新增 `packages/core/tests/hook/hook-p1-permreq-runtime-exit.test.ts`；P0 测试里 H2 的 `KNOWN_GAPS` 豁免删除，结构性「可 block 事件一票否决」断言现在也覆盖 PermissionRequest。`bun test ./packages/core/tests/hook/` 161 pass / 0 fail。
- 变异自证（逐条把修复改回去再跑两个测试文件）：H2 回退 4 fail、H3 回退 3 fail、H16 回退 3 fail、H14 回退 2 fail、H6/H7 回退（加回快速路径）5 fail。
- 9-27 复现脚本指向本分支代码重跑：场景 5 `isBlockingDecision = true | decision = deny`；场景 6 `ctor = PreToolUseHookOutput`；runtime 场景 A 产生 finalOutput、场景 C 实际耗时 57ms（原 603ms）；H14 `PWNED 文件是否被创建 = false`；H15-H18 场景【4】`output={}`。
- 删掉快速路径影响内部 runtime hook，补跑 trace / telemetry / debug / query / sdk / permission 测试目录：2679 pass / 0 fail。`make build` rc=0，`will always be undefined` 0 处。
