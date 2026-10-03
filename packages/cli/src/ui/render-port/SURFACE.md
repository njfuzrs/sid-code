<!-- 本文件由 scripts/tui-surface.ts 生成，勿手改。重新生成：bun run tui:surface -->
<!-- surface-signature: 29cf74045cf8f618 -->

# 渲染端口面（CLI 对渲染底座的全部依赖）

B9 / T0.1 产物。新底座必须提供这里列出的全部符号与 props；render-port 层覆盖的就是这个范围。
签名只由**集合**决定（符号 / props / 环境变量），计数是生成时快照，日常 UI 改动会让它漂移，不影响签名。

- 消费底座的源码文件：**101** 个（`packages/cli/src`，不含 `ui/render-port/` 自身）
- 直接 import 底座的测试文件：**19** 个（`packages/cli/tests`）
- 符号：**44** 个；宿主组件 props：**51** 种；底座读取的环境变量：**38** 个

## 1. 符号（按引用文件数降序）

| 符号 | 引用文件数 | 来源模块 | 备注 |
| --- | ---: | --- | --- |
| `Box` | 70 | `components/Box.tsx` |  |
| `Text` | 68 | `components/Text.tsx` |  |
| `Color` | 24 | `styles.ts` | 仅类型 |
| `useStdout` | 13 | `_vendor/use-stdout.ts` |  |
| `stringWidth` | 8 | `stringWidth.ts` |  |
| `DOMElement` | 6 | `dom.ts` | 仅类型 |
| `setClipboard` | 4 | `termio/osc.ts` | 含动态 import |
| `useStdin` | 3 | `hooks/use-stdin.ts` |  |
| `Ansi` | 2 | `Ansi.tsx` |  |
| `inkInstances` | 2 | `instances.ts` |  |
| `render` | 2 | `root.ts` | 含动态 import |
| `ResizeObserver` | 2 | `_vendor/resize-observer.ts` |  |
| `AlternateScreen` | 1 | `components/AlternateScreen.tsx` |  |
| `AnsiColor` | 1 | `styles.ts` | 仅类型 |
| `applyColor` | 1 | `colorize.ts` |  |
| `applyTextStyles` | 1 | `colorize.ts` |  |
| `BEL` | 1 | `termio/ansi.ts` |  |
| `ClockContext` | 1 | `components/ClockContext.tsx` |  |
| `colorize` | 1 | `colorize.ts` |  |
| `drainStdin` | 1 | `ink.tsx` | 含动态 import |
| `getBoundingBox` | 1 | `_vendor/get-bounding-box.ts` |  |
| `measureElement` | 1 | `measure-element.ts` |  |
| `osc` | 1 | `termio/osc.ts` |  |
| `OSC` | 1 | `termio/osc.ts` |  |
| `Props` | 1 | `components/Text.tsx` | 仅类型 |
| `RawAnsi` | 1 | `components/RawAnsi.tsx` |  |
| `setSuppressTerminalProbe` | 1 | `terminal.ts` | 含动态 import |
| `Static` | 1 | `_vendor/Static.tsx` |  |
| `StyledChar` | 1 | `_vendor/styled-chars.ts` | 仅类型 |
| `styledCharsWidth` | 1 | `_vendor/styled-chars.ts` |  |
| `supportsHyperlinks` | 1 | `supports-hyperlinks.ts` |  |
| `TabStatusKind` | 1 | `hooks/use-tab-status.ts` | 仅类型 |
| `TerminalSizeContext` | 1 | `components/TerminalSizeContext.tsx` |  |
| `TerminalWriteContext` | 1 | `useTerminalNotification.ts` |  |
| `toStyledCharacters` | 1 | `_vendor/styled-chars.ts` |  |
| `useAnimationFrame` | 1 | `hooks/use-animation-frame.ts` |  |
| `useApp` | 1 | `hooks/use-app.ts` |  |
| `useInput` | 1 | `hooks/use-input.ts` |  |
| `useTabStatus` | 1 | `hooks/use-tab-status.ts` |  |
| `useTerminalTitle` | 1 | `hooks/use-terminal-title.ts` |  |
| `widestLineFromStyledChars` | 1 | `_vendor/styled-chars.ts` |  |
| `wordBreakStyledChars` | 1 | `_vendor/styled-chars.ts` |  |
| `wrapForMultiplexer` | 1 | `termio/osc.ts` |  |
| `wrapStyledChars` | 1 | `_vendor/styled-chars.ts` |  |

## 2. 宿主组件 props（按出现次数降序）

「字面量取值」只列静态可知的值；「动态」是表达式取值的次数（运行时才知道值）。

| 组件.prop | 次数 | 文件数 | 字面量取值（次数） | 动态 |
| --- | ---: | ---: | --- | ---: |
| `Text.color` | 626 | 67 |  | 626 |
| `Box.flexDirection` | 273 | 66 | `column` 229、`row` 42 | 2 |
| `Box.marginTop` | 174 | 36 | `1` 156、`0` 14 | 4 |
| `Text.bold` | 130 | 43 | `true` 111 | 19 |
| `Box.width` | 88 | 39 | `2` 18、`100%` 7、`16` 2、`5` 2、`22` 1、`3` 1 | 57 |
| `Box.paddingX` | 83 | 40 | `1` 79、`2` 3 | 1 |
| `Box.paddingLeft` | 75 | 22 | `2` 60、`1` 10、`6` 1、`4` 1 | 3 |
| `Box.borderColor` | 68 | 32 |  | 68 |
| `Box.flexShrink` | 67 | 31 | `0` 66、`1` 1 | 0 |
| `Box.borderStyle` | 65 | 31 | `round` 60、`single` 5 | 0 |
| `Box.paddingY` | 50 | 25 | `0` 46、`1` 4 | 0 |
| `Text.italic` | 50 | 24 | `true` 49 | 1 |
| `Text.wrap` | 45 | 20 | `truncate-end` 20、`wrap` 16、`truncate` 6、`truncate-middle` 1 | 2 |
| `Box.key` | 35 | 21 |  | 35 |
| `Box.marginBottom` | 34 | 11 | `1` 33 | 1 |
| `Box.flexGrow` | 33 | 20 | `1` 28、`0` 5 | 0 |
| `Text.key` | 33 | 15 | `model` 1、`raw` 1、`vim` 1、`repo` 1、`gb` 1、`branch` 1、`wt` 1、`wtname` 1 | 25 |
| `Box.gap` | 11 | 9 | `1` 9、`0` 2 | 0 |
| `Box.justifyContent` | 11 | 8 | `flex-end` 4、`center` 3、`space-between` 2、`flex-start` 1 | 1 |
| `Box.alignItems` | 10 | 4 | `center` 3、`stretch` 3、`flex-start` 2 | 2 |
| `Box.marginLeft` | 9 | 6 | `1` 5、`2` 3 | 1 |
| `Box.overflow` | 9 | 6 | `hidden` 9 | 0 |
| `Box.paddingRight` | 8 | 6 | `1` 3、`2` 1、`4` 1 | 3 |
| `Box.height` | 7 | 5 | `1` 3、`100%` 1 | 3 |
| `Box.ref` | 6 | 5 |  | 6 |
| `Text.backgroundColor` | 6 | 4 |  | 6 |
| `Box.borderBottom` | 5 | 5 | `false` 5 | 0 |
| `Box.borderLeft` | 5 | 5 | `true` 3、`false` 2 | 0 |
| `Box.borderRight` | 5 | 5 | `false` 5 | 0 |
| `Box.flexWrap` | 5 | 3 | `nowrap` 3、`wrap` 2 | 0 |
| `Box.marginY` | 5 | 4 | `1` 4 | 1 |
| `Box.borderTop` | 4 | 4 | `false` 3、`true` 1 | 0 |
| `Box.marginRight` | 4 | 2 | `1` 3 | 1 |
| `Box.minHeight` | 4 | 2 | `1` 4 | 0 |
| `Text....spread` | 4 | 2 |  | 4 |
| `Text.inverse` | 4 | 2 | `true` 3 | 1 |
| `Text.strikethrough` | 4 | 3 | `true` 1 | 3 |
| `Box....spread` | 3 | 1 |  | 3 |
| `Box.backgroundColor` | 3 | 2 |  | 3 |
| `Box.minWidth` | 3 | 2 |  | 3 |
| `Box.padding` | 3 | 1 | `1` 3 | 0 |
| `Box.paddingBottom` | 3 | 3 | `1` 2 | 1 |
| `Box.maxHeight` | 2 | 1 |  | 2 |
| `Text.underline` | 2 | 2 | `true` 1 | 1 |
| `Box.alignSelf` | 1 | 1 | `flex-start` 1 | 0 |
| `Box.overflowX` | 1 | 1 | `hidden` 1 | 0 |
| `Box.overflowY` | 1 | 1 |  | 1 |
| `Box.paddingTop` | 1 | 1 | `1` 1 | 0 |
| `RawAnsi.lines` | 1 | 1 |  | 1 |
| `RawAnsi.width` | 1 | 1 |  | 1 |
| `Static.items` | 1 | 1 |  | 1 |

## 3. 底座读取的环境变量

新底座要逐个决定保留 / 改名 / 删除（D125：`CLAUDE_CODE_*` 改名，但 `CLAUDE_CODE_ACCESSIBILITY` 是功能开关，要保留功能）。

| 变量 | 读取位置（相对 tui-renderer/src） |
| --- | --- |
| `__CFBundleIdentifier` | `_vendor/env.ts` |
| `ALACRITTY_LOG` | `_vendor/env.ts` |
| `CLAUDE_CODE_ACCESSIBILITY` | `components/App.tsx` |
| `CLAUDE_CODE_COMMIT_LOG` | `reconciler.ts` |
| `CLAUDE_CODE_DEBUG_REPAINTS` | `reconciler.ts` |
| `CLAUDE_CODE_TMUX_TRUECOLOR` | `colorize.ts` |
| `ConEmuANSI` | `_vendor/env.ts`<br>`terminal.ts` |
| `ConEmuPID` | `_vendor/env.ts`<br>`terminal.ts` |
| `ConEmuTask` | `_vendor/env.ts`<br>`terminal.ts` |
| `CURSOR_TRACE_ID` | `_vendor/env.ts` |
| `GNOME_TERMINAL_SERVICE` | `_vendor/env.ts` |
| `KITTY_WINDOW_ID` | `_vendor/env.ts`<br>`terminal.ts` |
| `KONSOLE_VERSION` | `_vendor/env.ts` |
| `LC_TERMINAL` | `supports-hyperlinks.ts`<br>`termio/osc.ts` |
| `MSYSTEM` | `_vendor/env.ts`<br>`clearTerminal.ts` |
| `NODE_ENV` | `reconciler.ts` |
| `SESSIONNAME` | `_vendor/env.ts` |
| `SID_CODE_DEBUG` | `_vendor/debug.ts` |
| `SID_CODE_DISABLE_MOUSE_CLICKS` | `_vendor/fullscreen.ts` |
| `SID_DISABLE_TAB_STATUS` | `termio/osc.ts` |
| `SSH_CLIENT` | `_vendor/env.ts` |
| `SSH_CONNECTION` | `_vendor/env.ts`<br>`termio/osc.ts` |
| `SSH_TTY` | `_vendor/env.ts` |
| `STY` | `_vendor/env.ts`<br>`termio/osc.ts` |
| `TERM` | `_vendor/env.ts`<br>`supports-hyperlinks.ts`<br>`terminal.ts` |
| `TERM_PROGRAM` | `_vendor/env.ts`<br>`bidi.ts`<br>`clearTerminal.ts`<br>`colorize.ts`<br>`components/App.tsx`<br>`render-node-to-output.ts`<br>`supports-hyperlinks.ts`<br>`terminal.ts` |
| `TERM_PROGRAM_VERSION` | `clearTerminal.ts`<br>`terminal.ts` |
| `TERMINAL_EMULATOR` | `_vendor/env.ts` |
| `TERMINATOR_UUID` | `_vendor/env.ts` |
| `TILIX_ID` | `_vendor/env.ts` |
| `TMUX` | `_vendor/env.ts`<br>`colorize.ts`<br>`terminal.ts`<br>`termio/osc.ts` |
| `VisualStudioVersion` | `_vendor/env.ts` |
| `VSCODE_GIT_ASKPASS_MAIN` | `_vendor/env.ts` |
| `VTE_VERSION` | `_vendor/env.ts`<br>`terminal.ts` |
| `WSL_DISTRO_NAME` | `_vendor/env.ts` |
| `WT_SESSION` | `_vendor/env.ts`<br>`bidi.ts`<br>`clearTerminal.ts`<br>`terminal.ts` |
| `XTERM_VERSION` | `_vendor/env.ts` |
| `ZED_TERM` | `terminal.ts` |

## 4. CLI 绕过底座的 stdout 直写

端口层管不到这些写入，它们和底座写的是同一块终端（设计文档 §1.5）。终端序列 **16** 处，普通输出 6 处。判定是启发式的（参数含转义 / 模式常量 / OSC 变量），T5.3 收口时逐条复核。

| 位置 | 类型 | 代码 |
| --- | --- | --- |
| `packages/cli/src/ui/contexts/MouseContext.tsx:45` | 终端序列 | `process.stdout.write(ENABLE_MOUSE);` |
| `packages/cli/src/ui/contexts/MouseContext.tsx:50` | 终端序列 | `process.stdout.write(DISABLE_MOUSE);` |
| `packages/cli/src/ui/fullscreen.ts:19` | 终端序列 | `process.stdout.write("\x1b[?7l");` |
| `packages/cli/src/ui/fullscreen.ts:24` | 终端序列 | `process.stdout.write("\x1b[?7h");` |
| `packages/cli/src/ui/utils/terminalCapabilityManager.ts:40` | 终端序列 | `fs.writeSync(process.stdout.fd, TERMINAL_CLEANUP_SEQUENCE);` |
| `packages/cli/src/ui/utils/terminalCapabilityManager.ts:48` | 终端序列 | `process.stdout.write(DISABLE_KITTY);` |
| `packages/cli/src/ui/utils/terminalCapabilityManager.ts:49` | 终端序列 | `process.stdout.write(DISABLE_MODIFY_OTHER_KEYS);` |
| `packages/cli/src/ui/utils/terminalCapabilityManager.ts:50` | 终端序列 | `process.stdout.write(DISABLE_BRACKETED_PASTE);` |
| `packages/cli/src/ui/utils/terminalCapabilityManager.ts:87` | 终端序列 | `stdout.write(TerminalCapabilityManager.OSC_11_QUERY);` |
| `packages/cli/src/ui/utils/terminalCapabilityManager.ts:254` | 终端序列 | `process.stdout.write(ENABLE_KITTY);` |
| `packages/cli/src/ui/utils/terminalCapabilityManager.ts:258` | 终端序列 | `process.stdout.write(ENABLE_MODIFY_OTHER_KEYS);` |
| `packages/cli/src/ui/utils/terminalCapabilityManager.ts:261` | 终端序列 | `process.stdout.write(ENABLE_BRACKETED_PASTE);` |
| `packages/cli/src/command/commands/bug/bug.ts:74` | 终端序列 | `if (oscSeq) process.stdout.write(oscSeq);` |
| `packages/cli/src/command/commands/copy/copy.ts:65` | 终端序列 | `if (oscSeq) process.stdout.write(oscSeq);` |
| `packages/cli/src/command/commands/export/export.ts:155` | 终端序列 | `if (oscSeq) process.stdout.write(oscSeq);` |
| `packages/cli/src/command/commands/debug/debug.ts:50` | 终端序列 | `if (oscSeq) process.stdout.write(oscSeq);` |
| `packages/cli/src/app.ts:6880` | 普通输出 | `process.stdout.write(streamBuffer);` |
| `packages/cli/src/cli.ts:2041` | 普通输出 | `if (process.stdout.write(json)) resolve();` |
| `packages/cli/src/command/daemon.ts:132` | 普通输出 | `process.stdout.write(readFileSync(path, "utf-8"));` |
| `packages/cli/src/command/review.ts:261` | 普通输出 | `process.stdout.write(result.stdout);` |
| `packages/cli/src/command/review.ts:266` | 普通输出 | `process.stdout.write(finalResponse);` |
| `packages/cli/src/command/review.ts:267` | 普通输出 | `if (!finalResponse.endsWith("\n")) process.stdout.write("\n");` |

## 5. 直接 import 底座的测试文件

- `packages/cli/tests/ui/components/CoreRendering.test.tsx`
- `packages/cli/tests/ui/components/HotkeyChoiceList.test.tsx`
- `packages/cli/tests/ui/components/LoadingIndicator.test.tsx`
- `packages/cli/tests/ui/components/RetryStatus.test.tsx`
- `packages/cli/tests/ui/components/ShortcutsHelp.test.tsx`
- `packages/cli/tests/ui/components/TodoPanel.test.tsx`
- `packages/cli/tests/ui/components/footer-requests-column.test.tsx`
- `packages/cli/tests/ui/components/messages/CommandMessage.test.tsx`
- `packages/cli/tests/ui/components/messages/ToolMessage-think.test.tsx`
- `packages/cli/tests/ui/components/retry-status-shows-real-error.test.tsx`
- `packages/cli/tests/ui/components/startup-warning-banner.test.tsx`
- `packages/cli/tests/ui/hooks/useExitConfirm.test.tsx`
- `packages/cli/tests/ui/hooks/useLoadingIndicator-real-timer.test.tsx`
- `packages/cli/tests/ui/hooks/useLoadingIndicator.test.tsx`
- `packages/cli/tests/ui/hooks/useTerminalIntegration.test.tsx`
- `packages/cli/tests/ui/markdown-ansi-block-spacing.test.tsx`
- `packages/cli/tests/ui/model-dialog-render.test.tsx`
- `packages/cli/tests/ui/path-display.test.ts`
- `packages/cli/tests/ui/ui-utils.test.ts`
