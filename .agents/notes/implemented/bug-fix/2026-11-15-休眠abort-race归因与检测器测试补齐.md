---
Status: implemented
Date: 2026-11-15
Source: 排查诊断检测器精度治理落地方案（2026-11-02）
---
# digest 把宿主休眠引起的 abort race 归成故障，以及两条「测了但没测到」的检测器测试

## 决定了什么

### 1. T7 `errors_jsonl_has_entries`：按「时间邻近 `host_sleep_reopen`」归因宿主休眠

`digest.ts` 新增 `SLEEP_ABORT_RACE_WINDOW_MS = 60_000`：未恢复的错误记录若
① 文案匹配 `abort race`、② 与某个 `RetryTelemetry(host_sleep_reopen)` 事件时间差 ≤60s，
则视为「进程冻结期间 socket 被杀」，不再计入 high。

- 全是这种形态 → 合成**一条** `low`（kind 不变，下游统计口径不动）；
- 混有真错误 → high 只算真错误，detail 写出排除条数。

窗口不是拍的：真实样本 `20261014-224229` 里同一次事故的两侧差 **0.0 秒**（idx=22），
而同会话另一条不紧邻休眠的 abort race 差 **966 秒**（idx=27）。

### 2. T6 那条第 3 个测试改成真读落盘文件

`collector-increment-on-commit.test.ts` 原用例名承诺「增量与轨迹里能对上的 tool_result
数一致」，断言却只有 `getPrevMessageCount()===1`（游标值对、落盘内容切成空也能过），
注释还写「第一次请求带 2 条」而实际只喂 1 条。改为构造「tool_use + tool_result + 追问」
四条的上下文，重试后读 `raw.jsonl`，断言落盘那一轮的 `new_messages` 长度为 4 且含那个
`tool_result`。

### 3. 新增 `excluded_prompt_ms` 从闸门到落盘的端到端测试

`pairing-deadline.test.ts` 只覆盖 `promptMs()` 的扣减算术；「闸门开着 → 看门狗到点 →
collector 写进 events.jsonl」这条链路全仓无测试。新增
`collector-pairing-prompt-exclusion.test.ts`：把看门狗压到 150ms（env 注入），弹窗开 60ms
后关闭，断言 `excluded_prompt_ms > 0` 且不超过挂钟；另加「没有弹窗时恒为 0」的负向对照。

## 放弃了什么（以及为什么不选）

- **按文案直接跳过 abort race**：休眠之外的真 abort race（同会话 966s 那条）会被一起吞掉，
  正是这个检测器要报的东西。
- **按「会话里有休眠」整片降级**：一个会话可能既有休眠引起的、也有 provider 真挂的，
  会话级判据会把真故障藏起来。
- **把「弹窗一直开着等看门狗 fire」当作验收场景**：实测写不出这个场景 ——
  `onPairingTimeout` 里 `remainingMs() > 0` 会重排定时器，而弹窗期间 effective 被
  `promptMs()` 扣减，remaining 恒 > 0，看门狗永远不 fire（测试跑 3 秒也不落盘）。
  所以该字段的真实形态是「弹窗已关、本窗口内等过人」，测试按这个时序写。
- **继续等真实数据**：本机 55 条带 `excluded_prompt_ms` 的事件全部为 0，而那 17 个会话
  一个 HITL 段都没有 —— 等下去也等不到。字段名写错、单位写成秒、取快照而非增量这三种错，
  都能通过现有单测却永远等不到真实数据暴露，所以自己造。

## 拿什么证明它生效了

- 4 个相关测试文件 **31 pass / 0 fail**（`collector-pairing-prompt-exclusion` /
  `collector-increment-on-commit` / `digest-detector-precision-t5-t7` / `pairing-deadline`）。
- **变异自证 ①**：`SLEEP_ABORT_RACE_WINDOW_MS` 60s → 10000s，
  「abort race 离休眠 966 秒仍报 high」立刻变红（`Expected "high" Received "low"`）；恢复后全绿。
- **变异自证 ②**：把 `computeNewMessages` 改回「请求发出时推进游标」，
  T6 第 3 条变红（`Expected: 4 / Received: 0`）；恢复后全绿。
- `bun run affected-tests:run` → **1223 pass / 0 fail**（89 files）。
- `make build` → 编译产物自检全过。
- 真实数据佐证：`host_sleep_reopen` 在本机 32 个会话中出现，与 abort race 有 3 处重合；
  时间差实测 0.0s / 966s 两档，60s 窗口能分开。
- **未能证明的**：新判据在真实数据上的降级效果。本机现存 summary 都是落盘时点的快照，
  用当前代码重跑才是证据 —— 那一步在方案文档的验收里做，不在本 PR。
