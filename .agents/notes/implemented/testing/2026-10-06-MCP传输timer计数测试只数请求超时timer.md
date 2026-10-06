---
Status: implemented
Date: 2026-10-06
---
# MCP 传输 D8 timer 计数测试只统计请求超时 timer，消除 macOS CI 偶发红

## 决定了什么

`packages/core/tests/mcp/transport-robustness.test.ts` 里的 `trackTimers()` 原来会替换**进程级**
`setTimeout`，统计窗口内所有新建的 timer。在全量 `bun test` 下，其它测试文件遗留的异步尾巴也会在这个窗口内
建 timer，于是 macOS CI 偶发 `Expected: 0, Received: 1`。

现在 `trackTimers(onlyMs)` 只统计 delay 等于传输请求超时（`TRANSPORT_TIMEOUT_MS = 30000`）的 timer，
其余 timer 直接透传给原生 `setTimeout`。三个用例构造传输时也改用这个常量，测试与过滤条件共用一个数。

## 放弃了什么（以及为什么不选）

- **给用例加重试 / 调大等待**：掩盖问题，而且噪声 timer 与等待时长无关，重试只是降低概率。
- **改用 bun 的 fake timers**：要改三个用例的整体结构；同时 ws / stdio 依赖真实 I/O 回调，fake timers 下的推进时序更难推理。
- **在传输实现里暴露活跃 timer 数供测试读取**：为测试往生产代码加一个只读口子，不值得；
  在 delay 上过滤就足以把被测对象和噪声分开。

## 拿什么证明它生效了

- CI 历史：这条测试在 main（run 37429915217 的 ws、37456742177 的 stdio）和 PR #183（37477486170 的 ws）都在 macOS 上红过，
  ubuntu 均通过，被测的传输代码在这几次之间没有变化，所以判定为测试自身不稳定，不是回归。
- 变异自证：把 `transport.ts` 三处 cleanup 里的 `clearTimeout(timer)` 全部去掉，三条 D8 用例全部变红（17 个用例中 3 fail），还原后 17 pass。
  说明按 delay 过滤之后，测试仍然能抓到它要抓的缺陷。
- `bun run affected-tests:run`：1899 pass / 0 fail；`make build` 通过。
- 未证明：本地无法稳定复现原来的偶发红，「CI 不再偶发」要靠后续几次 macOS 运行来观察。
