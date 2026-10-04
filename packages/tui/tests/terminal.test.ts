/**
 * 新底座终端工具单测（B9 / T2.3）。与旧底座的逐字节对拍在
 * packages/cli/tests/render-port/contracts-termio.test.ts（经端口、legacy / next 子进程差分）。
 * 这里覆盖那边不方便造的分支：注入命令执行器，钉住剪贴板的调用顺序、缓存与超时。
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type CommandRunner,
  createSetClipboard,
  OSC,
  oscTerminator,
  supportsHyperlinks,
  wrapForMultiplexer,
} from "../src/terminal/index.ts";

describe("osc / wrapForMultiplexer", () => {
  test("终止符：kitty 用 ST，其余 BEL", () => {
    expect(oscTerminator({ TERM: "xterm-kitty" })).toBe("\x1b\\");
    expect(oscTerminator({ TERM_PROGRAM: "kitty" })).toBe("\x1b\\");
    expect(oscTerminator({ KITTY_WINDOW_ID: "3" })).toBe("\x1b\\");
    expect(oscTerminator({ KITTY_WINDOW_ID: "" })).toBe("\x07");
    expect(oscTerminator({ TERM: "xterm-KITTY" })).toBe("\x07");
    expect(oscTerminator({ TERM_PROGRAM: "Kitty" })).toBe("\x07");
    expect(oscTerminator({})).toBe("\x07");
  });

  test("终止符在模块加载时判定一次（子进程：加载后改 TERM 不影响）", () => {
    const code = `const m = await import(${JSON.stringify(join(import.meta.dir, "../src/terminal/osc.ts"))});
      process.env.TERM = "xterm-kitty"; process.stdout.write(JSON.stringify(m.osc(0, "t")));`;
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const k of ["TERM", "TERM_PROGRAM", "KITTY_WINDOW_ID"]) delete env[k];
    const r = Bun.spawnSync([process.execPath, "-e", code], { env });
    expect(JSON.parse(r.stdout.toString())).toBe("\x1b]0;t\x07");
  });

  test("tmux 优先于 screen，空值不算", () => {
    const seq = "\x1b]0;t\x07";
    expect(wrapForMultiplexer(seq, { TMUX: "x", STY: "y" })).toBe(
      "\x1bPtmux;\x1b\x1b]0;t\x07\x1b\\",
    );
    expect(wrapForMultiplexer(seq, { STY: "y" })).toBe("\x1bP\x1b]0;t\x07\x1b\\");
    expect(wrapForMultiplexer(seq, { TMUX: "", STY: "" })).toBe(seq);
  });

  test("OSC 表与端口面一致的 19 个编号", () => {
    expect(Object.keys(OSC)).toHaveLength(19);
    expect(OSC.CLIPBOARD).toBe(52);
    expect(OSC.TAB_STATUS).toBe(21337);
  });
});

describe("setClipboard（注入执行器）", () => {
  type Call = [string, string[], string, number | undefined];
  function setup(opts: {
    env?: Record<string, string>;
    platform?: NodeJS.Platform;
    ok?: (cmd: string) => boolean;
  }) {
    const calls: Call[] = [];
    const run: CommandRunner = async (cmd, args, input, timeoutMs) => {
      calls.push([cmd, args, input, timeoutMs]);
      return opts.ok ? opts.ok(cmd) : true;
    };
    const set = createSetClipboard({
      run,
      env: () => opts.env ?? {},
      platform: () => opts.platform ?? "darwin",
    });
    return { calls, set };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test("序列是 OSC 52 + utf8 base64", async () => {
    const { set } = setup({});
    expect(await set("a b\n中")).toBe(`\x1b]52;c;${Buffer.from("a b\n中").toString("base64")}\x07`);
  });

  test("平台工具：darwin pbcopy / win32 clip / 其他平台不调", async () => {
    for (const [platform, want] of [
      ["darwin", ["pbcopy"]],
      ["win32", ["clip"]],
      ["freebsd", []],
    ] as const) {
      const { calls, set } = setup({ platform });
      await set("hi");
      await flush();
      expect(calls.map((c) => c[0])).toEqual([...want]);
    }
  });

  test("SSH_CONNECTION 非空时不碰本机剪贴板；SSH_CLIENT / SSH_TTY 不算", async () => {
    const a = setup({ env: { SSH_CONNECTION: "1 2 3 4" } });
    await a.set("hi");
    await flush();
    expect(a.calls).toEqual([]);
    const b = setup({ env: { SSH_CLIENT: "1", SSH_TTY: "/dev/x" } });
    await b.set("hi");
    await flush();
    expect(b.calls.map((c) => c[0])).toEqual(["pbcopy"]);
  });

  test("linux：按序试探，记住第一个成功的；后来失败也不换", async () => {
    let failing = new Set(["wl-copy"]);
    const { calls, set } = setup({ platform: "linux", ok: (c) => !failing.has(c) });
    await set("1");
    await flush();
    await flush();
    expect(calls.map((c) => c[0])).toEqual(["wl-copy", "xclip"]);
    failing = new Set(["xclip"]);
    calls.length = 0;
    await set("2");
    await flush();
    expect(calls.map((c) => [c[0], c[1]])).toEqual([["xclip", ["-selection", "clipboard"]]]);
  });

  test("linux：三个都失败就记成没有，之后不再试", async () => {
    const { calls, set } = setup({ platform: "linux", ok: () => false });
    await set("1");
    for (let i = 0; i < 4; i++) await flush();
    expect(calls.map((c) => c[0])).toEqual(["wl-copy", "xclip", "xsel"]);
    calls.length = 0;
    await set("2");
    await flush();
    expect(calls).toEqual([]);
  });

  test("tmux：等 load-buffer（2s 超时）；成功返回包裹序列，失败返回原序列", async () => {
    const ok = setup({ env: { TMUX: "x" } });
    const seq = await ok.set("hi");
    expect(seq.startsWith("\x1bPtmux;")).toBe(true);
    expect(ok.calls.find((c) => c[0] === "tmux")).toEqual([
      "tmux",
      ["load-buffer", "-w", "-"],
      "hi",
      2000,
    ]);

    const bad = setup({ env: { TMUX: "x" }, ok: (c) => c !== "tmux" });
    expect(await bad.set("hi")).toBe("\x1b]52;c;aGk=\x07");
  });

  test("tmux 成功时包裹的里层固定用 BEL 终止，与外层终端无关（子进程：kitty 下加载）", () => {
    const code = `const m = await import(${JSON.stringify(join(import.meta.dir, "../src/terminal/clipboard.ts"))});
      const set = m.createSetClipboard({ run: async () => true, env: () => ({ TMUX: "x" }), platform: () => "freebsd" });
      const set2 = m.createSetClipboard({ run: async () => false, env: () => ({ TMUX: "x" }), platform: () => "freebsd" });
      process.stdout.write(JSON.stringify([await set("hi"), await set2("hi")]));`;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: "xterm-kitty",
    };
    const r = Bun.spawnSync([process.execPath, "-e", code], { env });
    expect(JSON.parse(r.stdout.toString())).toEqual([
      "\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\", // 包裹：里层 BEL
      "\x1b]52;c;aGk=\x1b\\", // 未包裹：按终端（kitty）用 ST
    ]);
  });

  test("tmux：LC_TERMINAL 恰好是 iTerm2 时不带 -w", async () => {
    for (const [lc, args] of [
      ["iTerm2", ["load-buffer", "-"]],
      ["iterm2", ["load-buffer", "-w", "-"]],
      ["ghostty", ["load-buffer", "-w", "-"]],
    ] as const) {
      const { calls, set } = setup({ env: { TMUX: "x", LC_TERMINAL: lc } });
      await set("hi");
      expect(calls.find((c) => c[0] === "tmux")?.[1]).toEqual([...args]);
    }
  });

  test("tmux + SSH：仍走 tmux，但不碰本机剪贴板", async () => {
    const { calls, set } = setup({ env: { TMUX: "x", SSH_CONNECTION: "1" } });
    await set("hi");
    await flush();
    expect(calls.map((c) => c[0])).toEqual(["tmux"]);
  });
});

describe("supportsHyperlinks", () => {
  test("库判定支持即支持", () => {
    expect(supportsHyperlinks({ stdoutSupported: true, env: {} })).toBe(true);
  });
  test("名单按 TERM_PROGRAM / LC_TERMINAL 精确命中；TERM 含小写 kitty", () => {
    const yes = [
      { TERM_PROGRAM: "iTerm.app" },
      { TERM_PROGRAM: "iTerm2" },
      { TERM_PROGRAM: "alacritty" },
      { LC_TERMINAL: "ghostty" },
      { TERM_PROGRAM: "tmux", LC_TERMINAL: "iTerm2" },
      { TERM: "xterm-kitty" },
    ];
    const no = [
      {},
      { TERM_PROGRAM: "ITERM.APP" },
      { TERM_PROGRAM: "Kitty" },
      { TERM_PROGRAM: "WezTerm" },
      { TERM_PROGRAM: "vscode" },
      { TERM: "xterm-ghostty" },
      { TERM: "KITTY" },
      { FORCE_HYPERLINK: "1" }, // 显式传 env 时只看名单；FORCE_HYPERLINK 由库在加载时处理
    ];
    for (const env of yes)
      expect(supportsHyperlinks({ stdoutSupported: false, env }), JSON.stringify(env)).toBe(true);
    for (const env of no)
      expect(supportsHyperlinks({ stdoutSupported: false, env }), JSON.stringify(env)).toBe(false);
  });
});
