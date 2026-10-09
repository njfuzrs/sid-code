/**
 * 契约 I4（B9 / T5.3a）：扩展键（kitty `>1u` / modifyOtherKeys `>4;2m`）开不开的判定，纯函数逐条。
 *
 * 期望值是 2026-10-08 对拍 legacy 子进程的实测（`env -i` 下逐组环境变量跑旧底座，看挂载时写没写 `>1u >4;2m`；
 * 约 1600 组随机 + 单变量组合与 `detectExtendedKeys` 0 不一致），没有读旧底座代码（设计文档 D-5）。
 * 两套底座按判定结果写字节由 `packages/cli/tests/render-port/terminal-modes.test.tsx` 子进程抽样验证。
 */
import { describe, expect, test } from "bun:test";
import { detectExtendedKeys } from "../src/terminal/extended-keys.ts";

const MATRIX: [Record<string, string>, boolean][] = [
  [{}, false],
  [{ TERM: "xterm-256color" }, false],
  [{ TERM_PROGRAM: "iTerm.app" }, true],
  [{ TERM_PROGRAM: "WezTerm" }, true],
  [{ TERM_PROGRAM: "ghostty" }, true],
  [{ TERM_PROGRAM: "kitty" }, true],
  [{ TERM_PROGRAM: "tmux" }, true],
  [{ TERM_PROGRAM: "vscode" }, false],
  [{ TERM_PROGRAM: "Apple_Terminal" }, false],
  [{ TERM_PROGRAM: "Ghostty" }, false], // 大小写敏感
  [{ TERM: "xterm-kitty" }, true],
  [{ TERM: "foo-kitty-bar" }, true],
  [{ TERM: "xterm-ghostty" }, true],
  [{ TERM: "xterm-ghostty-x" }, false],
  [{ TERM: "tmux" }, true],
  [{ TERM: "tmux-256color" }, false],
  [{ TERM: "windows-terminal" }, true],
  [{ KITTY_WINDOW_ID: "1" }, true],
  [{ KITTY_WINDOW_ID: "" }, false], // 空串 = 没设
  [{ WT_SESSION: "1" }, true],
  [{ TMUX: "/tmp/x,1,0" }, true],
  [{ STY: "1" }, false],
  // TERM_PROGRAM 优先于 TERM 原值与 TMUX；TERM 的 kitty / ghostty 优先于 TERM_PROGRAM
  [{ TERM_PROGRAM: "vscode", TMUX: "/x" }, false],
  [{ TERM_PROGRAM: "vscode", TERM: "xterm-kitty" }, true],
  [{ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-ghostty" }, true],
  // 非白名单终端的信号排在 KITTY_WINDOW_ID / WT_SESSION 之前，排在 TMUX 之后
  [{ STY: "1", KITTY_WINDOW_ID: "1" }, false],
  [{ STY: "1", TMUX: "/x" }, true],
  [{ TILIX_ID: "1", WT_SESSION: "1" }, false],
  [{ TILIX_ID: "1", KITTY_WINDOW_ID: "1" }, true],
  [{ SSH_TTY: "1", WT_SESSION: "1" }, true],
  [{ SSH_TTY: "1", TERM: "tmux" }, false],
  // IDE 内置终端信号最优先
  [{ CURSOR_TRACE_ID: "1", TERM: "xterm-kitty" }, false],
  [{ TERMINAL_EMULATOR: "JetBrains-JediTerm", TERM_PROGRAM: "kitty" }, false],
  [{ VisualStudioVersion: "1", TERM_PROGRAM: "kitty" }, false],
  [{ __CFBundleIdentifier: "com.jetbrains.goland", TERM_PROGRAM: "kitty" }, false],
  [{ __CFBundleIdentifier: "com.microsoft.VSCode", TERM_PROGRAM: "kitty" }, true],
  [{ VSCODE_GIT_ASKPASS_MAIN: "/a/cursor/b", TERM_PROGRAM: "kitty" }, false],
  [{ VSCODE_GIT_ASKPASS_MAIN: "/a/Cursor.app/b", TERM_PROGRAM: "kitty" }, true],
];

describe("I4: 扩展键判定（只看环境变量）", () => {
  test("I4: 逐条与旧底座实测一致", () => {
    for (const [env, want] of MATRIX) expect([env, detectExtendedKeys(env)]).toEqual([env, want]);
  });
});
