/**
 * 契约 O1 / O2（B9 / T7.2a）：终端标题与 tab 状态点。
 *
 * 期望值是 2026-10-08 legacy 实测（探针经端口挂假 TTY，记录每次提交后写出的字节）。
 * 只比 OSC 片段：帧本身、隐藏 / 显示光标归 R / X 组，不在这里断言。
 * kitty 的 ST 终止符在模块加载时判定，进程内改不了环境，由 contracts-termio.test.ts 的 O6 子进程矩阵覆盖。
 */
import { afterEach, describe, expect, test } from "bun:test";
import React, { useState } from "react";
import { Text } from "@sid-code/cli/ui/render-port/components.ts";
import { useTabStatus, useTerminalTitle } from "@sid-code/cli/ui/render-port/hooks.ts";
import type { TabStatusKind } from "@sid-code/cli/ui/render-port/types.ts";
import { mountTTY, tick, ttyStreams } from "./tty-streams.ts";

const BUSY = "\x1b]21337;indicator=#ff9500;status=Working…;status-color=#ff9500\x07";
const IDLE = "\x1b]21337;indicator=#00d75f;status=Idle;status-color=#888888\x07";
const WAITING = "\x1b]21337;indicator=#5f87ff;status=Waiting;status-color=#5f87ff\x07";
const CLEAR = "\x1b]21337;indicator=;status=;status-color=\x07";
const title = (t: string) => `\x1b]2;${t}\x07\x1b]0;${t}\x07`;

/** 只留 OSC 0/2/21337 与 tmux / screen 的 DCS 包裹，帧字节去掉 */
function oscOnly(s: string): string {
  const re = /\x1bP(?:tmux;)?(?:[^\x1b]|\x1b(?!\\))*?\x07\x1b\\|\x1b\](?:0|2|21337);[^\x07]*\x07/g;
  return (s.match(re) ?? []).join("");
}

const envBackup: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  if (!(k in envBackup)) envBackup[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
const platform = process.platform;
afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete envBackup[k];
  }
  Object.defineProperty(process, "platform", { value: platform });
});

type Setters = { title: (t: string | null) => void; tab: (k: TabStatusKind | null) => void };

/** 挂一个同时用两个 hook 的组件；返回每步 OSC 片段的取数器 */
async function mount(t0: string | null, s0: TabStatusKind | null) {
  const set = {} as Setters;
  function App() {
    const [t, setT] = useState(t0);
    const [s, setS] = useState(s0);
    set.title = setT;
    set.tab = setS;
    useTerminalTitle(t);
    useTabStatus(s);
    return <Text>x</Text>;
  }
  const streams = ttyStreams();
  const m = mountTTY(<App />, streams);
  await tick();
  const take = () => {
    const o = oscOnly(streams.out());
    streams.clear();
    return o;
  };
  const step = async (f: () => void) => {
    f();
    await tick();
    return take();
  };
  return { set, take, step, teardown: m.teardown };
}

describe("O1 终端标题", () => {
  test("O1: 先 OSC 2 再 OSC 0；内容去 ANSI；空串照写；null 不写；同值不重写", async () => {
    const h = await mount("hello", null);
    expect(h.take()).toBe(title("hello"));
    expect(await h.step(() => h.set.title("\x1b[31mred\x1b[0m t"))).toBe(title("red t"));
    expect(await h.step(() => h.set.title("red t"))).toBe(title("red t"));
    expect(await h.step(() => h.set.title("red t"))).toBe("");
    // 同上：由 tab 变化触发重渲，标题不变就不能重写
    expect(await h.step(() => h.set.tab("idle"))).toBe(IDLE);
    expect(await h.step(() => h.set.title(null))).toBe("");
    expect(await h.step(() => h.set.title(""))).toBe(title(""));
    h.teardown();
  });

  test("O1: OSC 8 链接、C1 CSI 去掉；孤立 ESC、DCS、换行与 BEL 原样", async () => {
    const h = await mount(null, null);
    expect(h.take()).toBe("");
    const link = "\x1b]8;;http://x\x07link\x1b]8;;\x07 \x1b[1mb\x1b[22m \x9b31mc";
    expect(await h.step(() => h.set.title(link))).toBe(title("link b c"));
    // 孤立 ESC：结果里带 ESC，oscOnly 不认，直接看原始字节
    const s = ttyStreams();
    const m = mountTTY(
      React.createElement(() => {
        useTerminalTitle("a\x1bz");
        return <Text>x</Text>;
      }),
      s,
    );
    await tick();
    expect(s.out()).toContain("\x1b]2;a\x1bz\x07\x1b]0;a\x1bz\x07");
    m.teardown();
    h.teardown();
  });

  test("O1: tmux / screen 下不包裹", async () => {
    setEnv("TMUX", "/tmp/x,1,0");
    const h = await mount("a", null);
    expect(h.take()).toBe(title("a"));
    h.teardown();
  });

  test("O1: Windows 不写序列，改写 process.title", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const before = process.title;
    const h = await mount("\x1b[1mWin\x1b[22m 标题", null);
    expect(h.take()).toBe("");
    expect(process.title).toBe("Win 标题");
    h.teardown();
    process.title = before;
  });
});

describe("O2 tab 状态点", () => {
  test("O2: 三种状态的字段；null 写清除；同值不重写", async () => {
    const h = await mount(null, "busy");
    expect(h.take()).toBe(BUSY);
    expect(await h.step(() => h.set.tab("idle"))).toBe(IDLE);
    expect(await h.step(() => h.set.tab("idle"))).toBe("");
    // setState 同值会被 React 跳过、不重渲；这里让标题变化触发重渲，tab 值不变就不能重写
    expect(await h.step(() => h.set.title("t"))).toBe(title("t"));
    expect(await h.step(() => h.set.tab("waiting"))).toBe(WAITING);
    expect(await h.step(() => h.set.tab(null))).toBe(CLEAR);
    h.teardown();
  });

  test("O2: 一开始就是 null 不写清除", async () => {
    const h = await mount(null, null);
    expect(h.take()).toBe("");
    expect(await h.step(() => h.set.tab("idle"))).toBe(IDLE);
    h.teardown();
  });

  test("O2: SID_DISABLE_TAB_STATUS 非空（含 0 / 空格）即关闭，空串不算", async () => {
    for (const [v, expected] of [
      ["1", ""],
      ["0", ""],
      [" ", ""],
      ["", BUSY],
    ] as const) {
      setEnv("SID_DISABLE_TAB_STATUS", v);
      const h = await mount(null, "busy");
      expect(h.take(), `SID_DISABLE_TAB_STATUS=${JSON.stringify(v)}`).toBe(expected);
      h.teardown();
    }
  });

  test("O2: 开关在每次状态变化时读；关闭期间的变化不写、不记账", async () => {
    const h = await mount(null, "busy");
    expect(h.take()).toBe(BUSY);
    setEnv("SID_DISABLE_TAB_STATUS", "1");
    expect(await h.step(() => h.set.tab("idle"))).toBe("");
    setEnv("SID_DISABLE_TAB_STATUS", undefined);
    expect(await h.step(() => h.set.tab("busy"))).toBe(BUSY);
    setEnv("SID_DISABLE_TAB_STATUS", "1");
    expect(await h.step(() => h.set.tab(null))).toBe("");
    setEnv("SID_DISABLE_TAB_STATUS", undefined);
    expect(await h.step(() => h.set.tab("waiting"))).toBe(WAITING);
    h.teardown();
  });

  test("O2: tmux 用 DCS 透传包裹（ESC 加倍），screen 用 DCS 包裹", async () => {
    setEnv("TMUX", "/tmp/x,1,0");
    let h = await mount(null, "busy");
    expect(h.take()).toBe(`\x1bPtmux;${BUSY.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`);
    h.teardown();
    setEnv("TMUX", undefined);
    setEnv("STY", "1.x");
    h = await mount(null, "busy");
    expect(h.take()).toBe(`\x1bP${BUSY}\x1b\\`);
    h.teardown();
  });

  test("O2: 组件卸载不写清除（退出时的清除归 Ink 卸载序列，X3）", async () => {
    let hide: () => void = () => {};
    function Child() {
      useTabStatus("busy");
      return <Text>c</Text>;
    }
    function App() {
      const [show, setShow] = useState(true);
      hide = () => setShow(false);
      return show ? <Child /> : <Text>-</Text>;
    }
    const s = ttyStreams();
    const m = mountTTY(<App />, s);
    await tick();
    expect(oscOnly(s.out())).toBe(BUSY);
    s.clear();
    hide();
    await tick();
    expect(oscOnly(s.out())).toBe("");
    m.teardown();
  });
});
