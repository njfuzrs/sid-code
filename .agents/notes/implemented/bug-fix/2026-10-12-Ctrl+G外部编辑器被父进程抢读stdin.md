---
Status: implemented
Date: 2026-10-12
---
# Ctrl+G 外部编辑器收不到按键：让渡时 pause stdin 流

## 决定了什么

`packages/tui/src/components/App.tsx` 的 `pauseForHandoff` 在让渡终端时调 `stdin.pause()`，
`resumeFromHandoff` 收回时调 `stdin.resume()`（用 `handoffPausedStreamRef` 保证重复让渡 / 收回只各调一次）。

根因：handoff 原本只靠 `isHandoffRef` 让 Ink 自己的 readable 监听不读，但 CLI 的
`KeypressContext` / `MouseContext` / `TerminalContext` 直接挂了 `stdin.on('data')`，流一直是 flowing，
父进程持续读 tty fd，和 spawn 出来的 vi 抢按键。用户看到的就是「vi 界面出来了但什么都输不进去」。

## 放弃了什么（以及为什么不选）

- **改用 `spawnSync` 起编辑器**：阻塞事件循环确实能让父进程不读 fd（pty 实测有效），但会冻住 Ink
  的 resize / SIGCONT 处理和所有定时器，而 X5 契约要求让渡期间这些仍被正确记账。
- **让渡时摘掉 CLI 各处的 data 监听**：要改三个 context 并让它们感知 handoff，耦合扩散到 CLI；
  pause 在流层面一次性解决，监听与解析器状态都不动，X5「期间输入不丢」照样成立。

## 拿什么证明它生效了

- 真 pty 驱动构建产物，`EDITOR` 指向包装 vi 的脚本，Ctrl+G 后输入 `A XYZEDITED <Esc> :wq`：
  修复前文件内容 `[TED]`（前面的按键被父进程吃掉），修复后 `[abcXYZEDITED]`。
- 假编辑器逐字节读 6 字节 `hello!`：修复前只收到 `68`（1 字节），修复后 `68656c6c6f21`。
- 新增 `packages/cli/tests/render-port/external-editor-stdin.test.tsx`：撤掉修复后红（`Expected "pause" / Received ""`），
  恢复后绿；X5 契约测试 `external-editor.test.tsx` 全部保持通过（26 pass / 0 fail）。
