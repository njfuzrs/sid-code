/**
 * 契约 M1 / R14（B9 / T6.1a）：`<AlternateScreen>` 的进出字节、鼠标跟踪开关、alt-screen 出帧。
 *
 * 期望值是 2026-10-08 对 legacy 的黑盒探针（D-5）。每个用例在子进程里跑 fixtures/alt-screen-app.tsx，
 * 两套底座各跑一次：先断言 legacy 本身满足写死的字节（防止测试和基线一起漂），再断言 next 与 legacy 逐段一致。
 *
 * 卸载那一段（`unmount` 标记之后）不比：卸载时恢复终端模式、清 OSC 进度属于生命周期（X 组，T7.1b）。
 */
import { describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = join(import.meta.dir, "fixtures/alt-screen-app.tsx");
const ESC = "\x1b";
const ENTER_ALT = `${ESC}[?1049h${ESC}[2J${ESC}[H`;
const EXIT_ALT = `${ESC}[?1049l`;
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h${ESC}[?1007h`;
const MOUSE_OFF = `${ESC}[?1007l${ESC}[?1006l${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l`;
const HOME = `${ESC}[H`;
const BSU = `${ESC}[?2026h`;
const ESU = `${ESC}[?2026l`;
const HIDE = `${ESC}[?25l`;

type Renderer = "legacy" | "next";

/** 跑一个用例，按 OSC 7777 标记切段：`{ 标记: 该标记之前那一段的字节 }`；`unmount` 之后的不要 */
function run(
  name: string,
  renderer: Renderer,
  env: Record<string, string> = {},
): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "alt-screen-"));
  const file = join(dir, "out");
  const fd = openSync(file, "w");
  try {
    const r = Bun.spawnSync(["bun", APP, name], {
      stdio: ["ignore", fd, fd],
      // 终端识别类变量清零（同 term-bench）：同步输出包裹看终端能力（R14），宿主终端不能漏进来
      env: {
        PATH: process.env.PATH!,
        HOME: process.env.HOME!,
        NODE_ENV: "test",
        TERM: "xterm-256color",
        SID_TUI_RENDERER: renderer,
        ...env,
      },
    });
    if (r.exitCode !== 0) throw new Error(`${renderer} ${name} 退出码 ${r.exitCode}`);
  } finally {
    closeSync(fd);
  }
  const raw = readFileSync(file, "utf8");
  rmSync(dir, { recursive: true, force: true });
  const segs: Record<string, string> = {};
  let start = 0;
  for (const m of raw.matchAll(/\x1b\]7777;([^\x07]*)\x07/g)) {
    segs[m[1]!] = raw.slice(start, m.index!);
    start = m.index! + m[0].length;
  }
  if (!("unmount" in segs))
    throw new Error(`${renderer} ${name} 没跑到 unmount 标记：${JSON.stringify(raw)}`);
  return segs;
}

/** legacy 满足写死的期望，next 与 legacy 逐段一致 */
function dual(name: string, expected: Record<string, string>, env?: Record<string, string>) {
  const legacy = run(name, "legacy", env);
  for (const [k, v] of Object.entries(expected))
    expect(legacy[k], `legacy ${name}「${k}」`).toBe(v);
  const next = run(name, "next", env);
  expect(next).toEqual(legacy);
}

const VSCODE = { TERM_PROGRAM: "vscode" };

describe("M1 鼠标跟踪随 alt-screen 进出", () => {
  test("M1: 挂载写 ?1049h 2J H + 鼠标全套，卸载先关鼠标（逆序）再 ?1049l；离开后下一帧 full reset", () => {
    dual("enterExit", {
      enter: ENTER_ALT + MOUSE_ON + `${HOME}hi${ESC}[6;1H`,
      exit: MOUSE_OFF + EXIT_ALT + `${BSU}${ESC}[2J${ESC}[3J${HOME}post\r\n${ESU}`,
    });
  });

  test("M1: mouseTracking={false} 不开也不关鼠标跟踪", () => {
    dual("noMouse", {
      enter: ENTER_ALT + `${HOME}hi${ESC}[6;1H${HIDE}`,
      exit: EXIT_ALT + `${BSU}${ESC}[2J${ESC}[3J${HOME}post\r\n${ESU}`,
    });
  });

  test("M1: mouseTracking 默认开", () => {
    dual("defaultProps", { enter: ENTER_ALT + MOUSE_ON + `${HOME}hi${ESC}[6;1H${HIDE}` });
  });

  test("M1: SID_CODE_DISABLE_MOUSE_CLICKS 不改变底座写的鼠标跟踪字节（点击的取舍在 CLI 侧）", () => {
    dual(
      "defaultProps",
      { enter: ENTER_ALT + MOUSE_ON + `${HOME}hi${ESC}[6;1H${HIDE}` },
      { SID_CODE_DISABLE_MOUSE_CLICKS: "1" },
    );
  });

  test("M1: mouseTracking 运行中切换 = 退出再进入，下一帧整帧重画", () => {
    dual("toggleMouse", {
      off: MOUSE_OFF + EXIT_ALT + ENTER_ALT + `${HOME}t${ESC}[6;1H`,
      on: EXIT_ALT + ENTER_ALT + MOUSE_ON + `${HOME}t${ESC}[6;1H`,
    });
  });

  test("M1: 嵌套 —— 各自写各自的进出字节，不做计数", () => {
    dual("nested", {
      enter: ENTER_ALT + ENTER_ALT + MOUSE_ON + `${HOME}n${ESC}[6;1H${HIDE}`,
      inner: EXIT_ALT + `${BSU}${ESC}[2J${ESC}[3J${HOME}n\r\n\r\n\r\n\r\n\r\n\r\n${ESU}`,
      outer: MOUSE_OFF + EXIT_ALT + `${BSU}${ESC}[2J${ESC}[3J${HOME}x\r\n${ESU}`,
    });
  });

  test("M1: 并列两个 —— 两遍进入字节，内容只画视口内的第一个", () => {
    dual("siblings", {
      enter: ENTER_ALT + MOUSE_ON + ENTER_ALT + MOUSE_ON + `${HOME}a${ESC}[6;1H${HIDE}`,
    });
  });

  test("M1: alt 下 resize 先重开鼠标跟踪，再 2J 整帧画、光标停到新的最后一行；尺寸不变不写", () => {
    dual("resize", {
      resized: MOUSE_ON + `${ESC}[2J${HOME}r${ESC}[8;1H`,
      sameSize: "",
      taller: MOUSE_ON + `${ESC}[2J${HOME}r${ESC}[9;1H`,
    });
  });
});

describe("R14 alt-screen 出帧（绝对定位）", () => {
  test("R14: 增量帧从 ESC[H 出发，只写变化的单元，收尾停在视口最后一行", () => {
    dual("enterExit", { update: `${HOME}\r${ESC}[1Bv2${ESC}[6;1H` });
  });

  test("R14: 内容高于视口时按 flex 收缩进视口；不能收缩时只画前 rows 行", () => {
    dual("tall", {
      enter:
        ENTER_ALT +
        MOUSE_ON +
        `${HOME}L4\r${ESC}[1BL9\r${ESC}[1BL14\r${ESC}[1BL19\r${ESC}[1BL24\r${ESC}[1BL29${ESC}[6;1H${HIDE}`,
      update: `${HOME}${ESC}[2Cx${ESC}[6;1H`,
    });
    dual("tallNoShrink", {
      enter:
        ENTER_ALT +
        MOUSE_ON +
        `${HOME}L0\r${ESC}[1BL1\r${ESC}[1BL2\r${ESC}[1BL3\r${ESC}[1BL4\r${ESC}[1BL5${ESC}[6;1H${HIDE}`,
    });
  });

  test("R14: overflowY scroll 在 alt 下裁剪（L3 规则不变）", () => {
    dual("scroll", { enter: ENTER_ALT + MOUSE_ON + `${HOME}\r${ESC}[5Bbar${ESC}[6;1H${HIDE}` });
  });

  test("R14: 变高 / 变矮按单元 diff，变矮用空格盖掉；没变化一个字节都不写", () => {
    dual("growShrink", {
      grow: `${HOME}\r${ESC}[1C${ESC}[1Bc\r${ESC}[1Bd${ESC}[6;1H`,
      shrink: `${HOME}\r${ESC}[1B  \r${ESC}[1B ${ESC}[6;1H`,
      same: "",
    });
  });

  test("R14: 样式与宽字符", () => {
    dual(
      "styled",
      {
        // 粗体下的空格照写（行首切样式后不再跳过），反色下同理
        enter:
          ENTER_ALT +
          MOUSE_ON +
          `${HOME}${ESC}[1ma b\r${ESC}[1B${ESC}[22m${ESC}[7mc d${ESC}[27m${ESC}[6;1H${HIDE}`,
      },
      { FORCE_COLOR: "3" },
    );
    dual("wide", { update: `${HOME}${ESC}[4Ccd\r${ESC}[2C${ESC}[1B y${ESC}[6;1H` });
  });

  test("R14: 空帧不写定位；第一次有内容才写", () => {
    dual("empty", { enter: ENTER_ALT + MOUSE_ON + HIDE, update: `${HOME}z${ESC}[6;1H` });
  });

  test("R14: alt 下 SIGCONT 重进 alt 擦屏，下一帧对空白整帧画", () => {
    dual("sigcont", { sigcont: ENTER_ALT, frame: `${HOME}s2${ESC}[6;1H` });
  });

  test("R14: 支持 DEC 2026 的终端（如 TERM_PROGRAM=vscode）alt 帧包同步输出；默认不包", () => {
    dual(
      "enterExit",
      {
        enter: ENTER_ALT + MOUSE_ON + `${BSU}${HOME}hi${ESC}[6;1H${ESU}`,
        update: `${BSU}${HOME}\r${ESC}[1Bv2${ESC}[6;1H${ESU}`,
      },
      VSCODE,
    );
    dual("resize", { resized: MOUSE_ON + `${BSU}${ESC}[2J${HOME}r${ESC}[8;1H${ESU}` }, VSCODE);
  });

  test("R14: tmux 里不包同步输出（压过 TERM_PROGRAM）", () => {
    dual(
      "enterExit",
      { update: `${HOME}\r${ESC}[1Bv2${ESC}[6;1H` },
      { ...VSCODE, TMUX: "/tmp/tmux-1/default,1,0" },
    );
  });
});
