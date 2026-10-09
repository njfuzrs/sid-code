---
Status: implemented
Date: 2026-10-10
---
# 终端探查回复不再漏进输入框：KeypressContext 吞掉 DCS 与私有前缀 CSI

## 决定了什么

`sid-code -r` 选中会话恢复后，输入框出现 `>|xterm.js(6.1.0-beta.304)1;2c`。
来源：新底座每次 raw mode 0→1 都发 `ESC[>0q` + `ESC[c`（`packages/tui/src/terminal-probe.ts`），
终端回 `ESC P >|xterm.js(…) ESC \` 与 `ESC[?1;2c`。底座自己的解析器认得这些回复，
但 `packages/cli/src/ui/contexts/KeypressContext.tsx` 直读 stdin 另起一套解析：
`ESC P` 被当成 Alt+Shift+P、后面逐字成了可插入字符；`ESC[?1;2c` 的 `?` 不被识别，`1;2c` 同样漏出。

改动只在 `emitKeys`：
- `ESC P` 后还有字节 ⇒ DCS，吞到 BEL / ST；只有 `ESC P` 两字节（ESC_TIMEOUT 冲刷）仍交出 Alt+Shift+P；
- CSI 首字节为 `?` / `>` / `=` ⇒ 终端回复（DA1/DA2/kitty 查询回复等），吞到终止字节。`<`（SGR 鼠标）不动。

## 放弃了什么（以及为什么不选）

- **抑制主 TUI 的探查**：探查结果用于认出 xterm.js（M4 链接不重复打开，T8.1a），关掉会丢功能。
- **只在 cli.ts 选择器之后多 drain 一次**：漏的是主 TUI 自己挂载时发的探查，不是选择器的残留，drain 时机对不上；
  且普通启动时回复同样会进这条解析器，只是到达快慢不同。
- **在底座里把回复从 stdin 拿掉**：KeypressContext 是 `stdin.on("data")` 并行监听，底座无法拦截同一 data 事件。

## 拿什么证明它生效了

- 伪终端（python pty，模拟 xterm.js 50ms / 300ms 后回复探查）跑 `sid-code -r` → 回车恢复：
  修前屏幕输出含 `>|xterm.js(6.1.0-beta.304)1;2c`；修后 `make build` 再跑，两种延迟下出现次数均为 0。
- `packages/cli/tests/ui/contexts/keypress-terminal-response.test.ts` 7 条；把两处判据改成 `false` 做变异，5 fail。
- `bun run affected-tests:run`：2196 pass / 0 fail；`bun run lint`、oxfmt 通过。
