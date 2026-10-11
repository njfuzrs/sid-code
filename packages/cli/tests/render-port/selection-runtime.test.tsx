/**
 * 契约 M3 / M4 / M5（B9 / T6.2b）：选区接入渲染、复制、超链接命中与打开。
 *
 * 期望值是 2026-10-09 对 legacy 的黑盒探针（D-5，没读旧代码），探针与原始结果备份在
 * `~/Backups/sid-code-t67-probe-results-20261008/T6.2b/`。全部经真实 SGR 鼠标字节驱动，不碰选区内部状态。
 */
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import chalk from "chalk";
import { Box, Text } from "@sid-code/cli/ui/render-port/components.ts";
import { useInput } from "@sid-code/cli/ui/render-port/hooks.ts";
import { mountTTY, tick, ttyStreams } from "./tty-streams.ts";

const ESC = "\x1b";
/**
 * 点击打开链接的用例要在独立进程里跑：旧底座把终端的 XTVERSION 回复记在进程级全局里，
 * 同一进程里前面的测试喂过 `xterm.js` 回复（如 stdin-response-fragment）之后，旧底座按 xterm.js 处理、
 * 不再自己开链接——那是它的正确行为，但会让这里的期望随测试顺序变。所以这些用例只在子进程里跑，
 * 外层用一条测试拉起子进程并断言它真的跑了、全过（不是被跳过的零断言全绿）。
 */
const ISOLATED = process.env.SID_SELECTION_CLICK_ISOLATED === "1";
const CLICK_CASES = 8; // M4 点击 2 条 + 禁用取值 6 条
const BSU = `${ESC}[?2026h`;
const ESU = `${ESC}[?2026l`;
/**
 * 剥掉帧外层的 DEC 2026 同步包裹再比。alt-screen 帧包不包由终端能力在模块加载时定（契约 R14，
 * `alt-screen.test.tsx` 覆盖），宿主是 VS Code / iTerm2 时包、CI runner 上不包。这里测的是选区字节，
 * 不剥的话本机绿、CI 两套底座一起红（B9 / T8.2 首次跑 CI 时实测）。
 */
const frame = (out: string) =>
  out.startsWith(BSU) && out.endsWith(ESU) ? out.slice(BSU.length, -ESU.length) : out;
const press = (x: number, y = 1) => `${ESC}[<0;${x};${y}M`;
const drag = (x: number, y = 1) => `${ESC}[<32;${x};${y}M`;
const release = (x: number, y = 1) => `${ESC}[<0;${x};${y}m`;
const link = (url: string, text: string) => `${ESC}]8;;${url}\x07${text}${ESC}]8;;\x07`;

const envBackup: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  if (!(k in envBackup)) envBackup[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
const level = chalk.level;
afterEach(() => {
  chalk.level = level;
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete envBackup[k];
  }
});

function Lines({ lines }: { lines: string[] }) {
  useInput(() => {});
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
    </Box>
  );
}

/** 挂载并进 alt-screen、出过一帧；`send` 写一串鼠标字节、每条之后等一拍 */
async function mountAlt(
  lines: string[],
  opts: { columns?: number; rows?: number; color?: string } = {},
) {
  chalk.level = 3;
  setEnv("TERM_PROGRAM", undefined);
  const s = ttyStreams({ columns: opts.columns ?? 30, rows: opts.rows ?? 10 });
  const m = mountTTY(<Lines lines={lines} />, s);
  await tick();
  m.ink.setAltScreenActive(true, true);
  if (opts.color) m.ink.setSelectionBgColor(opts.color);
  m.inst.rerender(<Lines lines={lines} />);
  await tick();
  const send = async (...seqs: string[]) => {
    for (const q of seqs) {
      s.stdin.write(q);
      await tick();
    }
  };
  return { s, m, send };
}

describe("M5 选区高亮落帧", () => {
  test("M5: 设了颜色 → 去掉原背景与反显、保留前景与其余样式，换上选区背景", async () => {
    chalk.level = 3;
    const t =
      chalk.red("ab") +
      chalk.bgBlue("cd") +
      chalk.inverse("ef") +
      chalk.bold.underline("gh") +
      "ij";
    const { s, m, send } = await mountAlt([t], { color: "#ff0000" });
    await send(press(1));
    s.clear();
    await send(drag(10));
    expect(frame(s.out())).toBe(
      `${ESC}[H${ESC}[31m${ESC}[48;2;255;0;0mab${ESC}[39mcdef${ESC}[1m${ESC}[4mgh${ESC}[24m${ESC}[22mij${ESC}[49m${ESC}[10;1H`,
    );
    // 选区缩小：退出选区的单元恢复原样式
    s.clear();
    await send(drag(3));
    expect(frame(s.out())).toBe(
      `${ESC}[H${ESC}[3C${ESC}[44md${ESC}[49m${ESC}[7mef${ESC}[27m${ESC}[1m${ESC}[4mgh${ESC}[24m${ESC}[22mij${ESC}[10;1H`,
    );
    m.teardown();
  });

  test("M5: 颜色认不出 → 与没设一样回退反显（已反显的单元不变）", async () => {
    chalk.level = 3;
    const t = chalk.red("ab") + chalk.inverse("cd");
    for (const color of ["bogus", undefined]) {
      const { s, m, send } = await mountAlt([t], { color });
      await send(press(1));
      s.clear();
      await send(drag(4));
      // 已经反显的 cd 涂完还是同一个样式，帧 diff 不写它
      expect(frame(s.out())).toBe(`${ESC}[H${ESC}[31m${ESC}[7mab${ESC}[27m${ESC}[39m${ESC}[10;1H`);
      m.teardown();
    }
  });

  test("M5: 多行选区首行涂到行尾、中间整行；内容以下的空行也能选、也涂", async () => {
    const { s, m, send } = await mountAlt(["ab"]);
    s.clear();
    await send(press(1), drag(3, 4));
    expect(frame(s.out())).toBe(
      `${ESC}[H${ESC}[7mab${" ".repeat(28)}\r${ESC}[1B${" ".repeat(30)}\r${ESC}[1B${" ".repeat(30)}\r${ESC}[1B   ${ESC}[27m${ESC}[10;1H`,
    );
    expect(m.ink.copySelectionNoClear()).toBe("ab\n\n\n");
    await tick(); // 复制的 OSC 52 是异步写的，等它落地再切段
    // 缩回来：伸到内容以下的高亮要盖掉，不残留
    s.clear();
    await send(drag(3, 2));
    expect(frame(s.out())).toBe(
      `${ESC}[H\r${ESC}[3C${ESC}[1B${" ".repeat(27)}\r${ESC}[1B${" ".repeat(30)}\r${ESC}[1B   ${ESC}[10;1H`,
    );
    m.teardown();
  });

  test("M5: clearTextSelection 有选区时当场重画、没有时不写；松开鼠标不重画", async () => {
    const { s, m, send } = await mountAlt(["hello world"], { color: "#ff0000" });
    s.clear();
    m.ink.clearTextSelection();
    await tick();
    expect(s.out()).toBe("");
    await send(press(1), drag(5));
    s.clear();
    await send(release(5));
    expect(s.out()).toBe("");
    m.ink.clearTextSelection();
    await tick();
    expect(frame(s.out())).toBe(`${ESC}[Hhello${ESC}[10;1H`);
    m.teardown();
  });

  test("M5: 中键 / 右键 / 滚轮 / 按键不清选区；主屏不建选区", async () => {
    const { s, m, send } = await mountAlt(["hello world"]);
    await send(press(1), drag(5), release(5));
    s.clear();
    await send(`${ESC}[<2;3;1M`, `${ESC}[<1;3;1M`, `${ESC}[<64;3;1M`, "a");
    expect(s.out()).toBe("");
    expect(m.ink.copySelectionNoClear()).toBe("hello");
    m.ink.setAltScreenActive(false);
    m.teardown();

    const main = ttyStreams();
    const mm = mountTTY(<Lines lines={["hello"]} />, main);
    await tick();
    main.clear();
    main.stdin.write(press(1));
    await tick();
    main.stdin.write(drag(5));
    await tick();
    expect(main.out()).toBe("");
    expect(mm.ink.copySelectionNoClear()).toBe("");
    mm.teardown();
  });
});

describe("M3 复制走 OSC 52", () => {
  test("M3: copySelectionNoClear 同步返回文本、异步写一条 OSC 52；不清选区；松开鼠标时不复制", async () => {
    setEnv("SSH_CONNECTION", "1 2 3 4"); // 不碰本机剪贴板
    for (const [k, v] of [
      ["TMUX", undefined],
      ["STY", undefined],
    ] as const)
      setEnv(k, v);
    const { s, m, send } = await mountAlt(["hello 世界 x"]);
    s.clear();
    await send(press(1), drag(10), release(10));
    await tick(50);
    expect(s.out()).not.toContain("]52;");
    s.clear();
    expect(m.ink.copySelectionNoClear()).toBe("hello 世界");
    expect(s.out()).toBe(""); // 同步阶段不写
    await tick();
    expect(s.out()).toBe(`${ESC}]52;c;${Buffer.from("hello 世界").toString("base64")}\x07`);
    expect(m.ink.copySelectionNoClear()).toBe("hello 世界");
    m.teardown();
  });

  test("M3: screen（STY）下不包裹；没有选区时什么都不写", async () => {
    setEnv("SSH_CONNECTION", "1 2 3 4");
    setEnv("TMUX", undefined);
    setEnv("STY", "123.pts");
    const { s, m, send } = await mountAlt(["hello"]);
    s.clear();
    expect(m.ink.copySelectionNoClear()).toBe("");
    await tick();
    expect(s.out()).toBe("");
    await send(press(1), drag(5), release(5));
    s.clear();
    m.ink.copySelectionNoClear();
    await tick();
    expect(s.out()).toBe(`${ESC}]52;c;aGVsbG8=\x07`);
    m.teardown();
  });
});

describe("M4 超链接命中与打开", () => {
  test("M4: getHyperlinkAt —— OSC 8 优先、宽字符右半格算左半格、行内纯文本 url、屏外与主屏为 undefined", async () => {
    const lines = [
      `ab ${link("https://x.test/1", "LINK")} 世${link("https://x.test/w", "界界")} end`,
      "x https://a.test/p?q=1. y",
      "(https://a.test/(a)) z",
      "ftp://f.test/x file:///tmp/a",
      "www.w.test HTTPS://U.TEST mailto:a@b.c",
      "xhttps://a.test/a'b",
      "https://a.test/中文",
      "https://a.test/a?! https://a.test/(a))",
    ];
    const { m } = await mountAlt(lines, { columns: 50, rows: 12 });
    const at = (x: number, y: number) => m.ink.getHyperlinkAt(x, y);
    expect([at(2, 0), at(3, 0), at(6, 0), at(7, 0)]).toEqual([
      undefined,
      "https://x.test/1",
      "https://x.test/1",
      undefined,
    ]);
    expect([at(10, 0), at(13, 0), at(14, 0)]).toEqual([
      "https://x.test/w",
      "https://x.test/w",
      undefined,
    ]);
    expect([at(1, 1), at(2, 1), at(21, 1), at(22, 1)]).toEqual([
      undefined,
      "https://a.test/p?q=1",
      "https://a.test/p?q=1",
      undefined,
    ]);
    expect([at(1, 2), at(19, 2)]).toEqual(["https://a.test/(a)", undefined]);
    expect([at(2, 3), at(15, 3)]).toEqual([undefined, "file:///tmp/a"]);
    expect([0, 12, 26].map((x) => at(x, 4))).toEqual([undefined, undefined, undefined]);
    expect([at(0, 5), at(1, 5), at(16, 5), at(17, 5)]).toEqual([
      undefined,
      "https://a.test/a",
      "https://a.test/a",
      undefined,
    ]);
    expect(at(0, 6)).toBe("https://a.test/");
    // 第二个 url 占 19–36 列，第 37 列那个多出来的 `)` 被去掉
    expect([at(0, 7), at(16, 7), at(18, 7), at(19, 7), at(36, 7), at(37, 7)]).toEqual([
      "https://a.test/a",
      undefined,
      undefined,
      "https://a.test/(a)",
      "https://a.test/(a)",
      undefined,
    ]);
    expect([at(-1, 0), at(3, 99), at(99, 0)]).toEqual([undefined, undefined, undefined]);
    m.ink.setAltScreenActive(false);
    expect(at(3, 0)).toBeUndefined();
    m.teardown();
  });

  async function clicks(script: (c: Awaited<ReturnType<typeof mountAlt>>) => Promise<void>) {
    const c = await mountAlt([
      `ab ${link("https://x.test/1", "LINK")} ${link("https://x.test/2", "TWO")} end`,
    ]);
    const opened: string[] = [];
    c.m.ink.onHyperlinkClick = (u) => opened.push(u);
    await script(c);
    const early = [...opened];
    await tick(600);
    c.m.teardown();
    return { early, opened };
  }

  test.if(ISOLATED)(
    "M4: 单击链接 → 等满连击窗口（500ms）后打开；双击 / 拖选 / 右键不开；第二个链接顶掉第一个",
    async () => {
      const single = await clicks(async (c) => c.send(press(5), release(5)));
      expect(single).toEqual({ early: [], opened: ["https://x.test/1"] });
      expect(
        (await clicks(async (c) => c.send(press(5), release(5), press(5), release(5)))).opened,
      ).toEqual([]);
      expect((await clicks(async (c) => c.send(press(4), drag(8), release(8)))).opened).toEqual([]);
      expect(
        (await clicks(async (c) => c.send(`${ESC}[<2;5;1M`, `${ESC}[<2;5;1m`))).opened,
      ).toEqual([]);
      expect(
        (await clicks(async (c) => c.send(press(5), release(5), press(10), release(10)))).opened,
      ).toEqual(["https://x.test/2"]);
      expect((await clicks(async (c) => c.send(press(1), release(1)))).opened).toEqual([]);
    },
  );

  test.if(ISOLATED)("M4: TERM_PROGRAM=vscode 不开（xterm.js 自己会开）", async () => {
    const r = await clicks(async (c) => {
      setEnv("TERM_PROGRAM", "vscode");
      await c.send(press(5), release(5));
    });
    expect(r.opened).toEqual([]);
  });
});

describe("SID_CODE_DISABLE_MOUSE_CLICKS", () => {
  for (const [v, disabled] of [
    ["1", true],
    ["true", true],
    ["yes", true],
    ["0", false],
    ["false", false],
    ["", false],
  ] as const) {
    test.if(ISOLATED)(
      `取值 ${JSON.stringify(v)} → ${disabled ? "选区和链接点击都不响应" : "照常响应"}`,
      async () => {
        setEnv("SID_CODE_DISABLE_MOUSE_CLICKS", v);
        const c = await mountAlt(["https://a.test/x", "", "hello world"]);
        const opened: string[] = [];
        c.m.ink.onHyperlinkClick = (u) => opened.push(u);
        await c.send(press(3), release(3));
        c.s.clear();
        await c.send(press(1, 3), drag(5, 3));
        await tick(600);
        expect(opened).toEqual(disabled ? [] : ["https://a.test/x"]);
        expect(c.s.out().includes(`${ESC}[7m`)).toBe(!disabled);
        c.m.teardown();
      },
    );
  }
});

test.if(!ISOLATED)(
  "M4 / 点击禁用：在独立进程里跑点击类用例（隔离旧底座的进程级 XTVERSION 状态）",
  () => {
    const r = Bun.spawnSync(
      [
        "bun",
        "test",
        import.meta.path,
        "-t",
        "M4: 单击|M4: TERM_PROGRAM|SID_CODE_DISABLE_MOUSE_CLICKS",
      ],
      {
        env: { ...process.env, SID_SELECTION_CLICK_ISOLATED: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = r.stdout.toString() + r.stderr.toString();
    expect(out).toMatch(new RegExp(`\\b${CLICK_CASES} pass\\b`));
    expect(out).toMatch(/\b0 fail\b/);
    expect(r.exitCode).toBe(0);
  },
  60000,
);
