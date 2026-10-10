/**
 * 契约 X5（B9 / T6.1b）：外部编辑器前后的 `enterAlternateScreen` / `exitAlternateScreen`。
 *
 * 期望值是 2026-10-09 对 legacy 的黑盒探针（D-5）。每个用例在子进程里跑 fixtures/external-editor-app.tsx，
 * 两套底座各跑一次：先断言 legacy 满足写死的字节（防止测试和基线一起漂），再断言 next 与 legacy 逐段一致。
 * 卸载那一段（`unmount` 标记之后）不比：属于生命周期（X3，T7.1b）。
 */
import { describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = join(import.meta.dir, "fixtures/external-editor-app.tsx");
const ESC = "\x1b";
const BSU = `${ESC}[?2026h`;
const ESU = `${ESC}[?2026l`;
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h${ESC}[?1007h`;
const MOUSE_OFF = `${ESC}[?1007l${ESC}[?1006l${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l`;
/** 让出终端时的公共前缀与后缀：关扩展键 …（主屏进 alt / alt 里关鼠标）… 关 focus、SGR 复位、显示光标、擦屏 */
const HANDOFF_HEAD = `${ESC}[<u${ESC}[>4m`;
const HANDOFF_TAIL = `${ESC}[?1004l${ESC}[0m${ESC}[?25h${ESC}[2J${ESC}[H`;
const KITTY = { TERM_PROGRAM: "kitty", KITTY_WINDOW_ID: "1" };
const REASSERT_KEYS = `${ESC}[<u${ESC}[>1u${ESC}[>4;2m`;

type Renderer = "legacy" | "next";

function run(name: string, renderer: Renderer, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "external-editor-"));
  const file = join(dir, "out");
  const fd = openSync(file, "w");
  try {
    const r = Bun.spawnSync(["bun", APP, name], {
      stdio: ["ignore", fd, fd],
      // 终端识别类变量清零：扩展键、同步输出包裹都看环境（同 alt-screen.test.tsx）
      env: {
        PATH: process.env.PATH!,
        HOME: process.env.HOME!,
        NODE_ENV: "test",
        TERM: "xterm-256color",
        SID_TUI_RENDERER: renderer,
        ...env,
      },
    });
    if (r.exitCode !== 0)
      throw new Error(`${renderer} ${name} 退出码 ${r.exitCode}：${readFileSync(file, "utf8")}`);
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

function dual(name: string, expected: Record<string, string>, env?: Record<string, string>) {
  const legacy = run(name, "legacy", env);
  for (const [k, v] of Object.entries(expected))
    expect(legacy[k], `legacy ${name}「${k}」`).toBe(v);
  const next = run(name, "next", env);
  // 挂载段（首帧 + raw mode 开启）不归 X5：两边隐藏光标的时机不同（I4 / X3 的事），只比之后的段
  delete legacy.mounted;
  delete next.mounted;
  expect(next).toEqual(legacy);
}

describe("X5 外部编辑器 handoff（主屏）", () => {
  test("X5: 让出先关 raw mode 再写 关扩展键 → ?1049h → 关 focus → SGR 复位 → 显示光标 → 擦屏；收回擦屏 → ?1049l → 隐藏光标 → 开 raw mode → 当场按 SIGCONT 口径出帧 → 开 focus", () => {
    dual("basic", {
      entered: `{raw:false}${HANDOFF_HEAD}${ESC}[?1049h${HANDOFF_TAIL}`,
      during: "EDITOR",
      exited: `${ESC}[2J${ESC}[H${ESC}[?1049l${ESC}[?25l{raw:true}${BSU}\r\n${ESU}${ESC}[?1004h`,
      afterExit: "",
    });
  });

  test("X5: 让渡期间的提交不出帧，收回时那一帧带上它", () => {
    dual("commit", {
      during: "EDITOR",
      exited: `${ESC}[2J${ESC}[H${ESC}[?1049l${ESC}[?25l{raw:true}${BSU}during\r\n${ESU}${ESC}[?1004h`,
    });
  });

  test("X5: 让渡期间新帧比旧帧矮，收回那一帧按首帧整帧画（不清屏）", () => {
    dual("shrink", {
      exited: `${ESC}[2J${ESC}[H${ESC}[?1049l${ESC}[?25l{raw:true}${BSU}during\r\n${ESU}${ESC}[?1004h`,
    });
  });

  test("X5: 让渡期间 resize 不出帧，收回时 full reset（视口变了）", () => {
    dual("resize", {
      during: "EDITOR",
      exited: `${ESC}[2J${ESC}[H${ESC}[?1049l${ESC}[?25l{raw:true}${BSU}${ESC}[2J${ESC}[3J${ESC}[Hmain\r\n${ESU}${ESC}[?1004h`,
    });
  });

  test("X5 × O5: 无障碍模式下收回终端照样隐藏光标（旧底座只在首帧与 Ctrl+Z 恢复时让步）", () => {
    dual(
      "commit",
      {
        exited: `${ESC}[2J${ESC}[H${ESC}[?1049l${ESC}[?25l{raw:true}${BSU}during\r\n${ESU}${ESC}[?1004h`,
      },
      { CLAUDE_CODE_ACCESSIBILITY: "1" },
    );
  });

  test("X5: 让渡期间的按键不丢，收回之后才交给 useInput", () => {
    dual("input", { during: "EDITOR", afterExit: "{input:q}" });
  });

  test("X5: 让渡期间 forceRedraw / SIGCONT 不写字节", () => {
    dual("redraw", { during: "EDITOR" });
    dual("sigcont", { during: "EDITOR" });
  });

  test("X5: 重复 enter / exit 每次整段再写；raw mode 只关 / 开一次", () => {
    dual("double", {
      entered2: `${HANDOFF_HEAD}${ESC}[?1049h${HANDOFF_TAIL}`,
      exited2: `${ESC}[2J${ESC}[H${ESC}[?1049l${ESC}[?25l${BSU}\r\n${ESU}${ESC}[?1004h`,
    });
  });

  test("X5: 没进过也照样执行 exit（不开 raw mode）", () => {
    dual("exitOnly", {
      exited: `${ESC}[2J${ESC}[H${ESC}[?1049l${ESC}[?25l${BSU}\r\n${ESU}${ESC}[?1004h`,
    });
  });

  test("X5: 没人持有 raw mode 时不碰 stdin", () => {
    dual(
      "basic",
      {
        entered: `${HANDOFF_HEAD}${ESC}[?1049h${HANDOFF_TAIL}`,
        exited: `${ESC}[2J${ESC}[H${ESC}[?1049l${ESC}[?25l${BSU}\r\n${ESU}${ESC}[?1004h`,
      },
      { FIXTURE_INPUT: "0" },
    );
  });

  test("X5: 扩展键开着时收回后重申扩展键（有没有人持有 raw mode 都写）", () => {
    dual(
      "basic",
      {
        exited: `${ESC}[2J${ESC}[H${ESC}[?1049l${ESC}[?25l{raw:true}${BSU}\r\n${ESU}${ESC}[?1004h${REASSERT_KEYS}`,
      },
      KITTY,
    );
    dual(
      "basic",
      {
        exited: `${ESC}[2J${ESC}[H${ESC}[?1049l${ESC}[?25l${BSU}\r\n${ESU}${ESC}[?1004h${REASSERT_KEYS}`,
      },
      { ...KITTY, FIXTURE_INPUT: "0" },
    );
  });

  test("X5: stdout 非 TTY 时让出前先写一遍当前帧，收回只写一对空的同步包裹", () => {
    dual(
      "basic",
      {
        entered: `${BSU}main${ESU}{raw:false}${HANDOFF_HEAD}${ESC}[?1049h${HANDOFF_TAIL}`,
        exited: `${ESC}[2J${ESC}[H${ESC}[?1049l${ESC}[?25l{raw:true}${BSU}${ESU}${ESC}[?1004h`,
      },
      { FIXTURE_TTY: "0" },
    );
  });
});

describe("X5 外部编辑器 handoff（已在 <AlternateScreen> 里）", () => {
  test("X5: 让出不再写 ?1049h、只关鼠标；收回重进 alt 擦屏 → 重开鼠标 → 隐藏光标 → 对空白整帧画", () => {
    dual("alt", {
      entered: `{raw:false}${HANDOFF_HEAD}${MOUSE_OFF}${HANDOFF_TAIL}`,
      during: "EDITOR",
      exited: `${ESC}[?1049h${ESC}[2J${ESC}[H${MOUSE_ON}${ESC}[?25l{raw:true}${ESC}[Hduring${ESC}[6;1H${ESC}[?1004h`,
    });
  });

  test("X5: mouseTracking={false} 时进出都不碰鼠标", () => {
    dual("altNoMouse", {
      entered: `{raw:false}${HANDOFF_HEAD}${HANDOFF_TAIL}`,
      exited: `${ESC}[?1049h${ESC}[2J${ESC}[H${ESC}[?25l{raw:true}${ESC}[Hduring${ESC}[6;1H${ESC}[?1004h`,
    });
  });

  test("X5: alt 里让渡期间 resize 不重开鼠标，收回后不再 2J；SIGCONT 照旧重进 alt", () => {
    dual("altResize", { during: "EDITOR" });
    dual("altSigcont", { during: `EDITOR${ESC}[?1049h${ESC}[2J${ESC}[H${MOUSE_ON}` });
  });

  test("X5: alt 里扩展键开着时收回也重申扩展键", () => {
    dual(
      "alt",
      {
        exited: `${ESC}[?1049h${ESC}[2J${ESC}[H${MOUSE_ON}${ESC}[?25l{raw:true}${BSU}${ESC}[Hduring${ESC}[6;1H${ESU}${ESC}[?1004h${REASSERT_KEYS}`,
      },
      KITTY,
    );
  });
});

// T5.3c：I4 × X5。让渡期间 raw mode 计数变化时输入模式怎么开关（2026-10-09 对 legacy 黑盒探针，D-5）。
// 结论：I4 的计数规则在让渡期间照常生效（0 → 1 当场开模式、发探查；归零当场关），不推迟到收回；
// 收回时的 `{raw:true}` 只看收回那一刻有没有人持有，`?1004h` 与扩展键重申照 X5 无条件写。CLI 在这条路径上不写模式（T5.3b）。
const ON_MODES = `{ref}{raw:true}${ESC}[?2004h${ESC}[?1004h`;
const PROBE = `${ESC}[>0q${ESC}[c`;
const OFF_MODES = `${ESC}[>4m${ESC}[<u${ESC}[?1004l${ESC}[?2004l{raw:false}{unref}`;
const EXIT_MAIN = `${ESC}[2J${ESC}[H${ESC}[?1049l${ESC}[?25l`;
const EXIT_ALT = `${ESC}[?1049h${ESC}[2J${ESC}[H${MOUSE_ON}${ESC}[?25l`;

describe("I4 × X5 让渡期间 raw mode 计数变化", () => {
  test("I4: 让渡中第一次有人要 raw mode → 当场开模式并探查；收回不再开 raw mode，只写 ?1004h；之后归零照常关", () => {
    dual(
      "mountDuring",
      {
        during: `EDITOR${ON_MODES}${PROBE}`,
        exited: `${EXIT_MAIN}${BSU}during\r\n${ESU}${ESC}[?1004h`,
        post: `${OFF_MODES}${BSU}\r${ESC}[1Apost  \r\n${ESU}`,
      },
      { FIXTURE_INPUT: "0" },
    );
    dual(
      "mountDuring",
      {
        during: `EDITOR${ON_MODES}${ESC}[>1u${ESC}[>4;2m${PROBE}`,
        exited: `${EXIT_MAIN}${BSU}during\r\n${ESU}${ESC}[?1004h${REASSERT_KEYS}`,
      },
      { ...KITTY, FIXTURE_INPUT: "0" },
    );
  });

  test("I4: 让渡中计数归零 → 当场关模式；收回仍开 raw mode、写 ?1004h（不看计数）；之后 0 → 1 照常开", () => {
    dual("unmountDuring", {
      during: `EDITOR${OFF_MODES}`,
      exited: `${EXIT_MAIN}{raw:true}${BSU}during\r\n${ESU}${ESC}[?1004h`,
      post: `${BSU}\r${ESC}[1Apost  \r\n${ESU}${ON_MODES}${PROBE}`,
    });
    dual(
      "unmountDuring",
      { exited: `${EXIT_MAIN}{raw:true}${BSU}during\r\n${ESU}${ESC}[?1004h${REASSERT_KEYS}` },
      KITTY,
    );
  });

  test("I4: 让渡中归零再回到 1 → 一关一开都当场写；收回只开一次 raw mode", () => {
    dual("remountDuring", {
      during: `EDITOR${OFF_MODES}{remount}${ON_MODES}${PROBE}`,
      exited: `${EXIT_MAIN}{raw:true}${BSU}during\r\n${ESU}${ESC}[?1004h`,
      post: `${BSU}\r${ESC}[1Apost  \r\n${ESU}`,
    });
  });

  test("I4: 已在 <AlternateScreen> 里，规则相同（收回走 alt 重进）", () => {
    dual(
      "altMountDuring",
      {
        during: `EDITOR${ON_MODES}${PROBE}`,
        exited: `${EXIT_ALT}${ESC}[Hduring${ESC}[6;1H${ESC}[?1004h`,
        post: `${OFF_MODES}${ESC}[Hpost  ${ESC}[6;1H`,
      },
      { FIXTURE_INPUT: "0" },
    );
    dual("altUnmountDuring", {
      during: `EDITOR${OFF_MODES}`,
      exited: `${EXIT_ALT}{raw:true}${ESC}[Hduring${ESC}[6;1H${ESC}[?1004h`,
      post: `${ESC}[Hpost  ${ESC}[6;1H${ON_MODES}${PROBE}`,
    });
  });
});
