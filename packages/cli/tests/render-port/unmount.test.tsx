/**
 * 契约 X3（B9 / T7.1b）：卸载时的终端恢复序列。两套底座都跑，期望值全部是 2026-10-09 对拍 legacy 的黑盒探针实测
 * （没有读旧底座代码，设计文档 D-5；探针备份在 `~/Backups/sid-code-t67-probe-results-20261008/T7.1b/`）。
 *
 * 必须是子进程：兜底段同步直写 fd 1，进程内的流对象截不到；`<W>` 标记出每一次经 `process.stdout.write` 的写入，
 * 没有标记的那段就是直写 fd 1（stdout 换成别的流时它仍落在 fd 1 上，见 pt 变体）。
 *
 * 实测出来的顺序（与设计文档 §4 X3 原描述的不同点在于「先后」）：
 * 1. 经 stdout：同步包裹的显示光标——**只在最后一帧动态区非空时写**（非 TTY：同步包裹的一个换行，且整段兜底都不写）；
 * 2. 直写 fd 1：退 alt（`<AlternateScreen>` 挂着时）→ 关鼠标跟踪（无条件）→ 关 modifyOtherKeys / kitty → 关 focus
 *    → 关 bracketed paste → 显示光标 → 清 OSC 9;4 进度 → 清 tab 状态；中间 drain stdin（Ctrl+Z 挂起中不 drain，I7）；
 * 3. 然后才是 React 清理：raw mode 释放（I4 那几段，各一次写入）、`<AlternateScreen>` 的关鼠标 + `?1049l`。
 * 第二次 unmount 什么都不写；SIGTERM 走同一条路径。
 */
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..");
const FIXTURE = join(import.meta.dir, "fixtures/unmount-app.tsx");
const E = "\x1b";

function unmountSegment(
  renderer: "legacy" | "next",
  variant: string,
  env: Record<string, string> = {},
): string {
  const r = Bun.spawnSync([process.execPath, FIXTURE, variant], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SID_CONFIG_DIR: process.env.SID_CONFIG_DIR ?? "",
      SID_TUI_RENDERER: renderer,
      TERM: "xterm-256color",
      NODE_ENV: "test",
      ...env,
    },
  });
  const out = r.stdout.toString();
  const i = out.indexOf("<UNMOUNT>");
  if (i < 0) throw new Error(`${renderer} ${variant} 没有走到卸载：\n${r.stderr.toString()}`);
  return out.slice(i + "<UNMOUNT>".length).replaceAll(E, "E");
}

const SHOW = "E[?2026hE[?25hE[?2026l";
const MOUSE_OFF = "E[?1007lE[?1006lE[?1003lE[?1002lE[?1000l";
const FALLBACK_TAIL =
  "E[>4mE[<uE[?1004lE[?2004lE[?25hE]9;4;0;\x07E]21337;indicator=;status=;status-color=\x07";
const fallback = (alt: boolean) => (alt ? "E[?1049l" : "") + MOUSE_OFF + FALLBACK_TAIL;
const RAW_OFF = "<W>E[?25h<W>E[>4m<W>E[<u<W>E[?1004l<W>E[?2004l";

const CASES: [string, string][] = [
  ["main", `<W>${SHOW}${fallback(false)}${RAW_OFF}<END>`],
  ["noraw", `<W>${SHOW}${fallback(false)}<W>E[?25h<END>`],
  ["alt", `<W>${SHOW}${fallback(true)}${RAW_OFF}<W>E[?1049l<END>`],
  ["alt-mouse", `<W>${SHOW}${fallback(true)}${RAW_OFF}<W>${MOUSE_OFF}E[?1049l<END>`],
  ["twice", `<W>${SHOW}${fallback(false)}${RAW_OFF}<AGAIN><END>`],
  [
    "pt",
    `<PT>${SHOW}</PT>${fallback(false)}` +
      "<PT>E[?25h</PT><PT>E[>4m</PT><PT>E[<u</PT><PT>E[?1004l</PT><PT>E[?2004l</PT><END>",
  ],
  [
    "ptnotty",
    "<PT>E[?2026hxE[?2026l</PT><PT>E[?2026h\nE[?2026l</PT>" +
      "<PT>E[>4m</PT><PT>E[<u</PT><PT>E[?1004l</PT><PT>E[?2004l</PT><END>",
  ],
  ["notty", "<W>E[?2026hxE[?2026l<W>E[?2026h\nE[?2026l<W>E[>4m<W>E[<u<W>E[?1004l<W>E[?2004l<END>"],
  ["sig", `<W>${SHOW}${fallback(false)}${RAW_OFF}`],
  ["alt-mouse-sig", `<W>${SHOW}${fallback(true)}${RAW_OFF}<W>${MOUSE_OFF}E[?1049l`],
  // 挂起时 raw mode 已经释放过，React 清理不再写 I4 那几段（I7）；兜底段照写
  ["susp", `<W>${SHOW}${fallback(false)}<W>E[?25h<END>`],
  ["alt-mouse-susp", `<W>${SHOW}${fallback(true)}<W>E[?25h<W>${MOUSE_OFF}E[?1049l<END>`],
];

/** 生产出帧调度（不设 `NODE_ENV=test`，16ms 窗口合并出帧）—— 末帧空不空只在这种调度下才与真实 CLI 一致 */
const PROD: [string, string][] = [
  // 最后一帧动态区是空的（CLI 退出前 isQuitting 那一帧就是）：① 那段经 stdout 的显示光标不写
  ["empty", `${fallback(false)}<W>E[?25h<END>`],
  ["pt-empty", `${fallback(false)}<PT>E[?25h</PT><END>`],
  ["notty-empty", "<W>E[?2026h\nE[?2026l<END>"],
  // 卸载那一刻才出的末帧把动态区擦空：先写擦除帧，① 照样不写
  ["toempty", `<W>E[?2026h\rE[1A${" ".repeat(40)}\rE[?2026l${fallback(false)}<W>E[?25h<END>`],
  // useApp().exit()：raw mode 释放先于卸载（I4 那几段在前），之后同 noraw
  ["appexit", `<W>E[>4m<W>E[<u<W>E[?1004l<W>E[?2004l<W>${SHOW}${fallback(false)}<W>E[?25h<END>`],
  // 直接 process.exit：signal-exit 的 exit 回调里卸载，与 SIGTERM 同字节
  ["exit", `<W>${SHOW}${fallback(false)}${RAW_OFF}`],
];

describe("X3: 卸载时的终端恢复序列", () => {
  test.each(CASES)("X3: %s", (variant, expected) => {
    const legacy = unmountSegment("legacy", variant);
    expect(legacy).toBe(expected);
    expect(unmountSegment("next", variant)).toBe(legacy);
  });

  test.each(PROD)("X3（生产调度）: %s", (variant, expected) => {
    const legacy = unmountSegment("legacy", variant, { NODE_ENV: "production" });
    expect(legacy).toBe(expected);
    expect(unmountSegment("next", variant, { NODE_ENV: "production" })).toBe(legacy);
  });

  // 环境相关的两处：tab 清除可关、按 tmux 包裹（规则归 O2，这里只确认兜底段里用的是同一套）
  test.each([
    ["SID_DISABLE_TAB_STATUS=1", { SID_DISABLE_TAB_STATUS: "1" }],
    ["TMUX", { TMUX: "/tmp/tmux-0/default,1,0" }],
  ] as const)("X3: alt-mouse + %s 与 legacy 一致", (_name, env) => {
    const legacy = unmountSegment("legacy", "alt-mouse", env);
    expect(legacy).toContain(MOUSE_OFF + "E[>4mE[<uE[?1004lE[?2004lE[?25hE]9;4;0;\x07");
    expect(unmountSegment("next", "alt-mouse", env)).toBe(legacy);
  });

  test("X3: SID_DISABLE_TAB_STATUS 时兜底段不写 tab 清除", () => {
    expect(unmountSegment("legacy", "main", { SID_DISABLE_TAB_STATUS: "1" })).not.toContain(
      "21337",
    );
  });
});
