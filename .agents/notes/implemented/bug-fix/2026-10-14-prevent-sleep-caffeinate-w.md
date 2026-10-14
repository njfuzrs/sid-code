---
Status: implemented
Date: 2026-10-14
---
# 防休眠改为 `caffeinate -i -w <pid>`，去掉「先杀后起」的定期重启

## 决定了什么

`packages/core/src/task/prevent-sleep.ts` 原实现每 4 分钟 `killCaffeinate(); spawnCaffeinate();`，
caffeinate 带 `-t 300` 自过期防孤儿。每次重启都制造一个「零 assertion」窗口，本机 `pmset sleep 1`
下用户早已空闲超时，assertion 一归零 powerd 立即启动 Idle Sleep——新进程同秒拉起也挡不回来。
会话 20261014-110202-8c0ffb30 的三个 explore 子代理就死在 12:59:50 那次（睡 184s）。

改为：refCount 0→1 时 spawn 一次 `caffeinate -i -w <process.pid>`，持有到 refCount 归零才 kill；
**不再定时重启**。`-w` 让主进程退出（含 SIGKILL）时 assertion 自动释放，原生解决 `-t` 想解决的孤儿问题。
caffeinate 意外退出时立即重拉，受 `RESPAWN_MAX_IN_WINDOW=3 / 60s` 上限保护（防死循环）。
spawner 可注入，单测断言 argv；`/doctor` 新增「防休眠」检查项（有保活需求却没持有 assertion 时 warn）。

## 放弃了什么（以及为什么不选）

- **缩短重启间隔**：窗口仍存在，只是更频繁。12:55:50 那次新进程同秒拉起、系统仍睡了 15s，证明「起得够快」不够。
- **先起后杀（重叠）**：能消窗口，但仍依赖会漂移的定时器（TimerDrift 实测 11.7s），且「重启」这个动作本身已不再有存在理由。
- **保留 `-t` 作双保险**：`-t` 到点就是又一次零 assertion，等于把 bug 换个周期重新引入。

## 拿什么证明它生效了

- 单测 `packages/shared/tests/utils/prevent-sleep.test.ts`「caffeinate -w」组：argv 恰为 `caffeinate -i -w <pid>` 不带 `-t`；
  refCount 1→2→1 spawn 1 次 kill 0 次；长时间持有不触发重启；意外退出立即重拉且受上限约束。
  变异：把 `-t 300` + 定时重启加回，「不会被定时重启」一条红。
- 基线（修复前，`pmset -g log`，本地时间 UTC+8，2026-10-14）——每次 `No Assertions` 后整 31 秒即 Idle Sleep：

  | caffeinate ClientDied `[System: No Assertions]` | Entering Sleep (Idle Sleep) | 时长 |
  | --- | --- | --- |
  | 10:44:47 | 10:45:18 | 354s |
  | 12:43:50 | 12:44:21 | 180s |
  | 12:55:50 | 12:56:21 | 15s |
  | **12:59:50** | **13:00:21** | **184s（本次事故）** |
  | 13:11:50 | 13:12:21 | 323s |
  | 13:21:44 | 13:22:15 | 691s |
  | 13:53:46 | 13:54:17 | 512s |

  另有 10:55:12、12:51:50 两次 `No Assertions` 后未睡（用户恰好有输入）。
- 生效判据（发版后复核）：sc-dev 跑任务 ≥ 30 分钟期间，`pmset -g log | grep caffeinate` 本进程的 `ClientDied` 为 0、
  `No Assertions` 为 0、Idle Sleep 为 0（合盖等主动休眠不算）。**本 PR 未做该真机复核**，留给 beta 泡制。
