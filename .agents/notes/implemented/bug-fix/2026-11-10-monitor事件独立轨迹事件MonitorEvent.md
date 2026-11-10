---
Status: implemented
Date: 2026-11-10
Source: monitor实测暴露的退出泄漏与审计口径缺陷-修复与验收方案（2026-11-09）
---
# monitor 事件落独立轨迹事件 MonitorEvent（FIX-4 D5）

## 决定了什么

monitor 的每条投递事件进轨迹：`packages/core/src/task/monitor-task.ts` 的
`enqueueMonitorEvent` 经模块级 sink（`setMonitorEventSink`）落一条
`MonitorEvent` 事件，载荷为 `{task_id, seq, chars, lines, dropped}`。

- **sink 形态与 `setTaskLifecycleSink` / `setWaitTraceSink` 同款**：模块级变量 +
  setter，接线在 `packages/cli/src/app.ts`（`setTaskLifecycleSink` 之后并排），
  未接线时静默跳过（单测 / 无轨迹会话照常）。方案已论证过不能直接调
  `traceCollector`（`packages/core/src/task/` 下没有任何文件 import trace，
  collector 没有模块级单例），所以走 sink 是唯一形态。
- **seq 取 updateTask 之后的 `eventCount`**（本条的投递序号，从 1 起连续），
  不新增计数器——`eventCount` 本来就是「已投递通知数」的权威计数，新开一个
  计数器会有两处真相。
- **dropped 只计终态冲刷截断的行**：`MonitorRateGate.drainAll` 记
  `lastDrainDropped = merged.length - kept.length`（入参行数 − 保留行数），
  仅 `finalizeAndDrain` 传给 sink。200ms 批合并**不计**（合并行完整保留在
  正文里，一行没丢；把合并算 dropped 会让几乎所有事件 dropped>0，指标失效——
  方案 D5 修复段的原话）。
- **`scripts/wait-audit.ts` 的 `monitor_events` 主口径改为读 events.jsonl**
  （`MonitorEvent` 条数，按 task_id 归属窗口内注册的 monitor，只卡起点不卡终点，
  与 raw 口径同规则）；原 raw 解析降级为 `monitor_events_raw` 交叉校验字段，
  `--with-raw` 时输出，两者不一致打 ⚠。`monitor_ev` 不再依赖 `--with-raw`
  （raw 每会话 2~3MB、默认不读，D2 的「monitor_ev=0 有两种含义」误解源就此消除）。
- **`scripts/verify-monitor.ts` 新增 `D5-events` case**：5 行、每行 ≥200ms 间隔的
  会话，断言 `MonitorEvent` 条数 == 投递数、seq 连续、task_id 一致
  （按 §7.4 的 D5-events 定义）。

## 放弃了什么（以及为什么不选）

- **直接调 `traceCollector.recordEvent`**：方案已论证不成立——方法名是
  `recordCustomEvent`，且 `packages/core/src/task/` 下没有任何文件 import trace，
  collector 没有模块级单例。照抄会写出一个引用不存在变量/方法的死代码。
- **在 sink 载荷里记录事件正文**：正文可含被监控进程的任意 stdout（外部不可信
  数据），且 chars/lines/dropped 已够审计复算（D2/D3 要验的是「条数、字符数、
  被截断丢弃的行数」，见方案 D5 影响段）。正文进 events.jsonl 会把 2~3MB 的
  raw 问题原样搬过去。
- **dropped 计批处理合并**：见上，方案 D5 明确警告过，会让指标失效。
- **wait-audit 完全删掉 raw 解析口径**：验收第 3 条要求「保留 raw 解析作为
  交叉校验（两者不一致时报错）」。降级为 `monitor_events_raw` + ⚠ 警告而不是
  硬报错退出：老轨迹（D5 合入前）天然两口径不一致（events=0，raw=N），硬报错
  会让所有历史会话的审计直接不可用。
- **给 ActiveMonitor 新增 seq 计数器**：`enqueueMonitorEvent` 已在 updateTask 里
  对 `eventCount` 自增，sink 处再读一次 getTask 即可拿到「含本条」的序号。
  新计数器 = 两个真相源，将来必然漂移。

## 拿什么证明它生效了

- 单测（`packages/core/tests/task/monitor-task.test.ts` 新增 describe「D5」）：
  - 3 行、间隔 0.25s → sink 收到 3 条，`seq=[1,2,3]`、`chars=[4,4,4]`、
    `lines=[1,1,1]`、`dropped` 全 0（批合并不算丢弃）✅
  - 未接线（sink=null）→ 投递照常、不抛错 ✅
  - 纯逻辑：205 行 drainAll → `drainDropped=5`；不截断 / 空冲刷 → 0 ✅
  - 端到端：突发阀路径（60 行）→ sink 收到 1 条终态事件，`dropped=20`、
    `lines=41`（40 行 + 截断提示行）✅
- **变异自证**：把 `if (monitorEventSink)` 短路成 `if (false)` → 两条端到端用例
  变红（`2 fail`），恢复后 40 pass 全绿（2026-11-10 本机实测输出）。
- wait-audit 单测：raw 口径断言迁移到 `monitor_events_raw`（去重 / 双格式 /
  真实渲染函数 3 条保持），新增 D5 主口径 3 条（task_id 归属且只卡起点 /
  老轨迹恒 0 靠 raw 分辨 / 不依赖 raw），70 pass。
- verify-monitor 单测：`collectMonitorEvents` 纯函数 4 条 + `D5-events` 可被
  `--case` 选中，全绿。
- `make build` 通过（自检：无进展止损阀 / 内置 skill / ripgrep / review skill 全过）。
- `bun scripts/verify-monitor.ts --case D5-events`（端到端验收）在 PR 描述中补跑结果。
