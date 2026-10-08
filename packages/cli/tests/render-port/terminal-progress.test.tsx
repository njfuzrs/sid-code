/**
 * 契约 O3（B9 / T7.2b）：原始终端写入口 TerminalWriteContext，与退出时清进度条 / tab 状态点。
 *
 * 期望值是 2026-10-08 legacy 实测（探针结果备份在
 * `~/Backups/sid-code-t67-probe-results-20261008/T7.2b/`）。每个环境在 legacy / next 两个子进程里各跑一遍，
 * 断言两边的 OSC 9 / 21337 片段都等于实测字节。
 * 卸载序列的其余部分（光标、鼠标、扩展键、bracketed paste）和它们与清除序列的相对顺序归 X3（T7.1b），
 * 这里不比 —— next 现在还缺那几段，整段比会让 O3 替 X3 红。
 */
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..");
const FIXTURE = join(import.meta.dir, "fixtures/osc-unmount-app.tsx");
// 宿主终端的识别变量一律清掉，只留矩阵里给的
const CLEAR = new Set([
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TMUX",
  "STY",
  "KITTY_WINDOW_ID",
  "WT_SESSION",
  "LC_TERMINAL",
  "SID_DISABLE_TAB_STATUS",
  "SID_TUI_RENDERER",
  "CI",
]);

function run(renderer: "legacy" | "next", env: Record<string, string>) {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !CLEAR.has(k)) base[k] = v;
  const r = Bun.spawnSync([process.execPath, FIXTURE], {
    cwd: ROOT,
    env: { ...base, TERM: "xterm-256color", SID_TUI_RENDERER: renderer, ...env },
  });
  const s = r.stdout.toString();
  if (r.exitCode !== 0 || !s.includes("<END")) {
    throw new Error(`${renderer} 夹具失败（rc=${r.exitCode}）：${r.stderr.toString()}`);
  }
  const u = s.indexOf("<UNMOUNT>");
  const e = s.indexOf("<END");
  return { mount: s.slice(0, u), unmount: s.slice(u + 9, e), end: s.slice(e) };
}

const PROGRESS_CLEAR = "\x1b]9;4;0;\x07";
const TAB_CLEAR = "\x1b]21337;indicator=;status=;status-color=";
/** 卸载段里只留 OSC 9 / 21337 与 tmux / screen 包裹 */
function oscOnly(s: string): string {
  const re =
    /\x1bP(?:tmux;)?(?:[^\x1b]|\x1b(?!\\))*?\x07\x1b\\|\x1b\](?:9|21337);[^\x07\x1b]*(?:\x07|\x1b\\)/g;
  return (s.match(re) ?? []).join("");
}

const MATRIX: [string, Record<string, string>, string][] = [
  ["默认", {}, PROGRESS_CLEAR + TAB_CLEAR + "\x07"],
  // 进度清除固定 BEL、不换 ST；tab 清除随终端用 ST
  ["kitty TERM", { TERM: "xterm-kitty" }, PROGRESS_CLEAR + TAB_CLEAR + "\x1b\\"],
  ["KITTY_WINDOW_ID", { KITTY_WINDOW_ID: "1" }, PROGRESS_CLEAR + TAB_CLEAR + "\x1b\\"],
  // 进度清除不包裹；tab 清除按 tmux / screen 包裹
  ["tmux", { TMUX: "/tmp/x,1,0" }, PROGRESS_CLEAR + "\x1bPtmux;\x1b" + TAB_CLEAR + "\x07\x1b\\"],
  ["screen", { STY: "1.x" }, PROGRESS_CLEAR + "\x1bP" + TAB_CLEAR + "\x07\x1b\\"],
  // 与终端是否支持进度条无关：Windows Terminal / VS Code 一律写
  ["WT_SESSION", { WT_SESSION: "x" }, PROGRESS_CLEAR + TAB_CLEAR + "\x07"],
  ["SID_DISABLE_TAB_STATUS=1", { SID_DISABLE_TAB_STATUS: "1" }, PROGRESS_CLEAR],
  ["SID_DISABLE_TAB_STATUS=0（非空即关）", { SID_DISABLE_TAB_STATUS: "0" }, PROGRESS_CLEAR],
  ["非 TTY", { FIXTURE_TTY: "0" }, ""],
];

describe("O3 退出时清进度条与 tab 状态点", () => {
  for (const [name, env, expected] of MATRIX) {
    test(`O3: ${name}`, () => {
      const legacy = run("legacy", env);
      const next = run("next", env);
      expect(oscOnly(legacy.unmount)).toBe(expected);
      expect(oscOnly(next.unmount)).toBe(expected);
    });
  }
});

describe("O3 原始写入口 TerminalWriteContext", () => {
  // 与首帧的先后不断言：测试环境（NODE_ENV=test）同步出帧（R13），先后随环境变，不是 O3 的一部分
  const once = (s: string) => s.split("<RAW>").length - 1;

  test("O3: 底座提供函数、重渲后身份不变、原样直写 stdout", () => {
    for (const renderer of ["legacy", "next"] as const) {
      const r = run(renderer, {});
      expect(r.end).toBe("<END ctx=function renders=2 stable=true>");
      // 身份稳定 ⇒ 依赖它的 effect 重渲不重跑 ⇒ 恰好一次
      expect(once(r.mount)).toBe(1);
    }
  });

  test("O3: 非 TTY 下也写", () => {
    for (const renderer of ["legacy", "next"] as const) {
      expect(once(run(renderer, { FIXTURE_TTY: "0" }).mount)).toBe(1);
    }
  });
});
