---
Status: implemented
Date: 2026-10-09
---
# 新底座无障碍模式保留原生光标，底座环境变量逐个定论（契约 O5，B9 / T7.2c，D125）

## 决定了什么

- 新增 `packages/tui/src/cursor-helpers.ts` 的 `keepsNativeCursor()`，接进两处隐藏光标：
  - `ink.tsx`：主屏和 alt 两条出帧路径里「首次隐藏光标」那一步；
  - `components/App.tsx`：Ctrl+Z 挂起后 SIGCONT 恢复时写的 `?25l`（`?1004h` 照写）。
- 规则来自黑盒对拍旧底座（D-5，没读旧代码）：
  - 取值非空、且不是 `0` / `false` / `no`（不分大小写）就算开。`abc`、单个空格都算开，空串算关。
  - **每次要隐藏时读**环境变量，不在加载时缓存。
  - **外部编辑器收回终端（`exitAlternateScreen`）照样隐藏光标**，主屏和 alt 都一样，旧底座如此。这条写成了 X5 × O5 的双底座用例。
  - 之后的帧、resize、`forceRedraw` 都不再补写隐藏。
- 改名（D125）：next 认 `SID_CODE_ACCESSIBILITY`，旧名 `CLAUDE_CODE_ACCESSIBILITY` 留作别名到 T9。新名只要设置了（含空串）就以新名为准，口径同 `colorize.ts` 的 `SID_CODE_TMUX_TRUECOLOR`。
- `SURFACE.md` §3 每个变量加了「新底座结论」列。数据在 `scripts/tui-surface.ts` 的 `ENV_DECISIONS` 里（SURFACE.md 是生成件）。`tests/scripts/tui-surface.test.ts` 双向校验：结论表的键集合 = 扫描结果，并且 `CLAUDE_CODE_*` 只能是「改名」或「删除」。

| 变量 | 结论 |
| --- | --- |
| `CLAUDE_CODE_ACCESSIBILITY` | 改名 `SID_CODE_ACCESSIBILITY`，功能保留 |
| `CLAUDE_CODE_TMUX_TRUECOLOR` | 改名 `SID_CODE_TMUX_TRUECOLOR`（T2.2 已做） |
| `CLAUDE_CODE_COMMIT_LOG` | 删除：旧底座临时的提交计时埋点 |
| `CLAUDE_CODE_DEBUG_REPAINTS` | 删除：full reset 原因已从 `onFrame` 的 `flickers[].reason` 暴露 |
| `CLAUDE_CODE_DISABLE_MOUSE` | 不存在：只出现在旧底座注释里，从来没有代码读它，扫描也没扫到 |

## 放弃了什么

- **没把 CLI 的 `SID_ACCESSIBILITY` 合并进底座开关**。两个「无障碍」开关不是一回事：CLI 的 `SID_ACCESSIBILITY` / `SID_SCREEN_READER`（`ui/accessibility/detect.ts`）管关动画，底座这个只管光标，旧底座不认前者（实测过）。合并会改变 legacy 基线的行为。
- **没删旧名**：`CLAUDE_CODE_ACCESSIBILITY` / `CLAUDE_CODE_TMUX_TRUECOLOR` 留作别名到 T9，否则在用旧名的人切到 next 时会静默失效。
- **没给 `CLAUDE_CODE_COMMIT_LOG` / `CLAUDE_CODE_DEBUG_REPAINTS` 做对应实现**。前者是旧底座的临时埋点，后者的信息 `onFrame` 已经给了。

## 不显然的地方

- 「`SID_CODE_DEBUG` / `SID_CODE_DISABLE_MOUSE_CLICKS` 底座读了、next 还不读」不算 O5 的缺口。它们分别跟着 E1（T7.1a）和点击处理（T6.2b）走，表里写了归属。
- `TERM_PROGRAM_VERSION` / `SESSIONNAME` next 不读。前者旧底座用来判 OSC 9;4 可用性和 win32 VS Code 清屏，后者只用来认 cygwin，而 cygwin 不在扩展键白名单里，认没认出来可观察行为都一样。win32 旧控制台的清屏差异 next 没实现，表里写了「T9 前评估」。
- 变异自证 8 处，第一轮 7 红 1 绿。绿的那处是「恢复时漏写 `?1004h`」：断言 `toContain("?1004h")` 被 raw mode 重开输入模式（I4）写的那条 `?1004h` 顶替了。改成数次数（恢复时恰好 2 次）后转红。

## 拿什么证明它生效了

- `contracts-runtime.test.tsx` O5 从 2 条扩到 17 条（真值表 13 条、后续帧 / resize / forceRedraw、Ctrl+Z 恢复），双底座全绿。`external-editor.test.tsx` 新增 X5 × O5。`packages/tui/tests/terminal.test.ts` 新增新旧名优先级单测。
- render-port：legacy 407 / 0。next 402 / 5，剩下的 5 条是 M5 ×2、X7（T6.2）、S10（T7.1a）、S13（T6.2c），全是既有的、归属别的任务，**O5 已不在其中**。
- 探针脚本和结果备份在 `~/Backups/sid-code-t67-probe-results-20261008/T7.2c/`，不入库。
- 全量 `bun test` 双跑：legacy 15071 pass / 1 fail（`changelog-curated`，分支既有）。next 15064 / 8 → 修掉本 Note 自身的章节缺失后为 7：`changelog-curated`、K1 `ShortcutsHelp`、M5 ×2、X7、S10、S13，全是既有。`tsc` 88 与 HEAD 相同；`lint` / `lint:boundary` / `format:check` / `tui:similarity` / `tui:surface --check` / `tui:spec` / `docs:gen-reference --check` 通过；`make build` 通过、无 `will always be undefined`。
