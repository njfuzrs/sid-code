/**
 * DEC 2026 同步输出能力判定（B9 / T6.1a，契约 R14）。期望值来自对旧底座的 `env -i` 黑盒探针：
 * 只设一个变量起子进程，看 alt-screen 帧有没有包 `?2026h … ?2026l`。
 */
import { describe, expect, test } from "bun:test";
import { supportsSynchronizedOutput } from "../src/terminal/sync-output.ts";

const yes: Record<string, string>[] = [
  { TERM_PROGRAM: "iTerm.app" },
  { TERM_PROGRAM: "vscode" },
  { TERM_PROGRAM: "WezTerm" },
  { TERM_PROGRAM: "ghostty" },
  { TERM_PROGRAM: "WarpTerminal" },
  { TERM_PROGRAM: "alacritty" },
  { TERM_PROGRAM: "contour" },
  { KITTY_WINDOW_ID: "1" },
  { WT_SESSION: "x" },
  { ZED_TERM: "true" },
  { ZED_TERM: "1" },
  { VTE_VERSION: "6800" },
  { VTE_VERSION: "7000" },
  { VTE_VERSION: "6800x" },
  { VTE_VERSION: " 6800" },
  { TERM: "xterm-kitty" },
  { TERM: "kitty" },
  { TERM: "foo-kitty" },
  { TERM: "kitty-direct" },
  { TERM: "alacritty" },
  { TERM: "xterm-alacritty" },
  { TERM: "foot" },
  { TERM: "foot-direct" },
  { TERM: "footx" },
  { TERM: "xterm-ghostty" },
  { STY: "x", TERM_PROGRAM: "vscode" },
  { TERM: "tmux-256color", TERM_PROGRAM: "vscode" },
  { TMUX: "", TERM_PROGRAM: "vscode" },
];

const no: Record<string, string>[] = [
  {},
  { TERM: "xterm-256color" },
  { TERM_PROGRAM: "Apple_Terminal" },
  { TERM_PROGRAM: "tmux" },
  { TERM_PROGRAM: "Hyper" },
  { TERM_PROGRAM: "kitty" },
  { TERM_PROGRAM: "zed" },
  { TERM_PROGRAM: "iterm.app" },
  { TERM_PROGRAM: "iTerm2" },
  { TERM_PROGRAM: "Ghostty" },
  { TERM_PROGRAM: "wezterm" },
  { TERM_PROGRAM: "Alacritty" },
  { TERM_PROGRAM: "Warp" },
  { TERM_PROGRAM: "rio" },
  { KONSOLE_VERSION: "220000" },
  { ALACRITTY_LOG: "x" },
  { KITTY_WINDOW_ID: "" },
  { WT_SESSION: "" },
  { ZED_TERM: "" },
  { VTE_VERSION: "6799" },
  { VTE_VERSION: "abc" },
  { TERM: "Kitty" },
  { TERM: "wezterm" },
  { TERM: "ghostty" },
  { TERM: "xterm-ghostty-x" },
  { TERM: "xterm-foot" },
  { TERM: "contour" },
  { TERM: "screen" },
  { STY: "x" },
  { TMUX: "/tmp/x,1,0" },
  { TMUX: "x", TERM_PROGRAM: "iTerm.app" },
  { TMUX: "x", TERM: "xterm-kitty" },
  { TMUX: "x", KITTY_WINDOW_ID: "1" },
];

describe("supportsSynchronizedOutput", () => {
  for (const env of yes)
    test(`支持：${JSON.stringify(env)}`, () => expect(supportsSynchronizedOutput(env)).toBe(true));
  for (const env of no)
    test(`不支持：${JSON.stringify(env)}`, () =>
      expect(supportsSynchronizedOutput(env)).toBe(false));
});
