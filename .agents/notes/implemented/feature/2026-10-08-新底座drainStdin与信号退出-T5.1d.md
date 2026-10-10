---
Status: implemented
Date: 2026-10-08
---
# 新底座 drainStdin、detachForShutdown 与静默后模式重申（B9 / T5.1d）

## 决定了什么

规则全部来自对拍 legacy 的黑盒探针。`_probe_misc / w` 是已有的，`i1c / i1c2 / i1c3 / x4 / x4b / x4c / fd` 是本次补的。没有读旧底座代码（D-5）。探针结果备份在 `~/Backups/sid-code-t51-probe-results-20261007/t51d/`。

- **I5 `drainStdin`**：新增 `packages/tui/src/drain-stdin.ts`，端口 next 不再走 `notImplementedFn`。行为如下：
  - 非 TTY 不动。
  - 循环 `read()` 直到返回 null。
  - 原本不在 raw mode 的，补一次 `setRawMode(true)` 再 `setRawMode(false)`；原本在 raw mode 的不碰。
  - 不经 fd 直读：探针里 fd 上的 10 字节原样留着，也没有调用 `readSync`。
  - 每一步都吞错。
- **X4 `detachForShutdown`**：加在 `Ink` 上。它置 `isUnmounted`、取消两条帧调度、drain，最后关 raw mode，顺序是先 drain 后关。它不走 App 的 `disableRawMode`，因为 legacy 实测有这几条：
  - 不 `unref`；
  - 不摘 `readable`，之后的输入照样送到 `useInput`；
  - 不摘 SIGCONT / resize 监听；
  - 不结算 exit promise。
  T5.1c 留下的提示是「走 `disableRawMode`」，但探针证明它会摘 readable、清计数，和 legacy 不符，所以没有照做。
- **I1c 模式重申**：App 在每轮 `readable` 的第一块记一次时间戳，距上一块（或挂载时刻）严格大于 5000ms 就回调 `onStdinResume`。重新启用时被丢弃的那块也算。Ink 只在 alt-screen 且开了鼠标跟踪时重写鼠标跟踪全套，不擦屏；主屏、非 TTY 都不写。
- SPEC 里 I1c / I5 / X4 三条描述按实测补全，`UPSTREAM-DIFF.md` 加 3 行。

## 放弃了什么

- **X4 复用 App 的 `disableRawMode` / `pauseInput`**：代码更少，但会摘 `readable`、清计数。legacy 在 detach 之后还能把输入送到 `useInput`，复用它会把这个差异藏进「退出路径」，没人会去对拍那里。
- **`drainStdin` 用 `fs.readSync(fd)` 把内核缓冲也读干净**：对「退出后残留字节进 shell」更彻底，但 legacy 不这么做，非阻塞 fd 上还要处理 EAGAIN。这次是对拍，不是修正。
- **I1c 在主屏也重申 bracketed paste / focus**：legacy 主屏一个字节都不写，照搬。

## 拿什么证明它生效了

- next 上 `contracts-runtime + stdin-dual-reader + stdin-ownership` 是 63 pass / 3 fail，剩下的只有 M5 ×2（T6.2）和 O5（T7.2）。I1c、I5 ×2、X4 已转绿，I6 保持绿。
- 新正式契约测试 `packages/cli/tests/render-port/stdin-shutdown.test.tsx` 共 18 条，legacy 和 next 都是 18/18。
- 9 个探针在 next 上重跑，输出与 legacy 的 json 逐字节一致。唯一的差异是 `_probe_w` 里栈帧的函数名，不属于行为。
- 变异自证：阈值 `>` 改成 `>=`，红 1 条；X4 去掉 drain，红 6 条。两处都按 sha1 还原。
- 探针 `_probe_misc / _probe_w` 以及本次另建的 7 个都已删除，只剩 `_probe_z`（T5.1e）。
- `tsc` 70 个错误，与 T5.1c 记录的数相同，没有新增。`tui:spec` 62 条、59 条已测。`lint:boundary` 0 处。
