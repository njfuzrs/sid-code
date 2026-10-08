/**
 * 契约 I7（B9 / T5.1e）：Ctrl+Z 挂起与 SIGCONT 恢复。两套底座都跑。
 *
 * 期望值全部是 2026-10-08 对拍 legacy 的黑盒探针实测（`_probe_z / z2 … z9`），没有读旧底座代码（设计文档 D-5）。
 * 旧底座在恢复路径上还会重发终端探查（`ESC[>0q` + DA1），那是 I2，归 T5.2，这里比较前先剥掉。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import React from "react";
import { Text } from "@sid-code/cli/ui/render-port/components.ts";
import { useInput, useStdin } from "@sid-code/cli/ui/render-port/hooks.ts";
import { forgetRenderInstance } from "@sid-code/cli/ui/render-port/testing.ts";
import { mountTTY, tick, ttyStreams } from "./tty-streams.ts";

const E = "\x1b";
/** 挂起前写出的关模式序列：前 4 段 stdout 非 TTY 也写，后 7 段只在 TTY 下写 */
const STOP_BASE = `${E}[>4m${E}[<u${E}[?1004l${E}[?2004l`;
const STOP_TTY = `${E}[?25h${E}[?1004l${E}[?1007l${E}[?1006l${E}[?1003l${E}[?1002l${E}[?1000l`;
/** SIGCONT 后的重开序列 */
const CONT_BASE = `${E}[?2004h${E}[?1004h`;
const CONT_TTY = `${E}[?25l${E}[?1004h`;
const MOUSE_ALL = `${E}[?1000h${E}[?1002h${E}[?1003h${E}[?1006h${E}[?1007h`;
const REENTER_ALT = `${E}[?1049h${E}[2J${E}[H`;

const stripProbe = (s: string) => s.replaceAll(`${E}[>0q${E}[c`, "");

let kills: string[];
let killSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  kills = [];
  killSpy = spyOn(process, "kill").mockImplementation(((pid: number, sig: string) => {
    if (pid === process.pid) kills.push(sig);
    return true;
  }) as never);
});
afterEach(() => killSpy.mockRestore());

type Log = unknown[];
function setup(opts: { tty?: boolean; alt?: boolean; mouse?: boolean } = {}) {
  const s = ttyStreams({ stdoutTTY: opts.tty ?? true });
  const log: Log = [];
  const calls: string[] = [];
  const st = s.stdin as unknown as Record<string, (...a: unknown[]) => unknown>;
  const raw = st.setRawMode!.bind(s.stdin);
  const ref = st.ref!;
  const unref = st.unref!;
  Object.assign(s.stdin, {
    setRawMode: (v: boolean) => {
      calls.push(`raw:${v}`);
      return raw(v);
    },
    ref: () => {
      calls.push("ref");
      return ref();
    },
    unref: () => {
      calls.push("unref");
      return unref();
    },
  });
  function C() {
    useInput((i, key) => log.push([i, key.ctrl, key.meta]));
    return <Text>x</Text>;
  }
  const m = mountTTY(<C />, s);
  return {
    s,
    m,
    log,
    calls,
    async ready() {
      await tick();
      if (opts.alt) m.ink.setAltScreenActive(true, opts.mouse ?? false);
      await tick();
      s.clear();
      calls.length = 0;
    },
    take() {
      const o = stripProbe(s.out());
      s.clear();
      return o;
    },
  };
}

async function cont() {
  process.emit("SIGCONT" as never);
  await tick();
}

describe("I7: Ctrl+Z 挂起与恢复", () => {
  test("I7: TTY 主屏：写关模式序列 → 关 raw mode + unref → SIGSTOP；SIGCONT 后先开 raw mode 再写重开序列", async () => {
    const t = setup();
    await t.ready();
    const before = process.listenerCount("SIGCONT");
    t.s.stdin.write("\x1a");
    await tick();
    expect(t.take()).toBe(STOP_BASE + STOP_TTY);
    expect(kills).toEqual(["SIGSTOP"]);
    expect(t.calls).toEqual(["raw:false", "unref"]);
    expect(t.s.stdin.isRaw).toBe(false);
    expect(t.s.stdin.listenerCount("readable")).toBe(0);
    expect(process.listenerCount("SIGCONT") - before).toBe(1);
    expect(t.log).toEqual([]); // Ctrl+Z 不交给 useInput

    t.calls.length = 0;
    await cont();
    expect(t.take()).toBe(CONT_BASE + CONT_TTY);
    expect(t.calls).toEqual(["ref", "raw:true"]);
    expect(t.s.stdin.isRaw).toBe(true);
    expect(t.s.stdin.listenerCount("readable")).toBe(1);
    expect(process.listenerCount("SIGCONT") - before).toBe(0); // 一次性监听
    t.m.teardown();
  });

  test("I7: stdout 非 TTY：只写前 4 段关模式与 2 段重开，仍然 SIGSTOP", async () => {
    const t = setup({ tty: false });
    await t.ready();
    t.s.stdin.write("\x1a");
    await tick();
    expect(t.take()).toBe(STOP_BASE);
    expect(kills).toEqual(["SIGSTOP"]);
    await cont();
    expect(t.take()).toBe(CONT_BASE);
    expect(t.s.stdin.isRaw).toBe(true);
    t.m.teardown();
  });

  test("I7: alt-screen：SIGCONT 先重进 alt 擦屏（开过鼠标跟踪的重开），再写重开序列", async () => {
    for (const mouse of [true, false]) {
      const t = setup({ alt: true, mouse });
      await t.ready();
      t.s.stdin.write("\x1a");
      await tick();
      expect(t.take()).toBe(STOP_BASE + STOP_TTY);
      await cont();
      expect(t.take()).toBe(REENTER_ALT + (mouse ? MOUSE_ALL : "") + CONT_BASE + CONT_TTY);
      t.m.teardown();
    }
  });

  test("I7: 认的是解码后的 Ctrl+Z（含 kitty / modifyOtherKeys 与叠加修饰），不认 release / 文本 / 粘贴", async () => {
    const stops = [
      "\x1a",
      `${E}[122;5u`,
      `${E}[90;5u`,
      `${E}[122;6u`,
      `${E}[122;7u`,
      `${E}[122;13u`,
      `${E}[122;69u`,
      `${E}[27;5;122~`,
      `${E}[27;6;122~`,
    ];
    const keeps: Array<[string, Log]> = [
      [`${E}\x1a`, [["\x1a", false, false]]],
      ["\x1a\x1a", [["\x1a\x1a", false, false]]],
      ["\x1ab", [["\x1ab", false, false]]],
      [`${E}[122;5:2u`, [["", false, false]]],
      [`${E}[122;5:3u`, [["", false, false]]],
      [`${E}[26;5u`, [["", true, false]]],
      [`${E}[200~\x1a${E}[201~`, [["\x1a", false, false]]],
    ];
    for (const q of stops) {
      kills.length = 0;
      const t = setup();
      await t.ready();
      t.s.stdin.write(q);
      await tick();
      expect([q, kills, t.log]).toEqual([q, ["SIGSTOP"], []]);
      await cont();
      t.m.teardown();
    }
    for (const [q, log] of keeps) {
      kills.length = 0;
      const t = setup();
      await t.ready();
      t.s.stdin.write(q);
      await tick();
      expect([q, kills, t.log, t.take()]).toEqual([q, [], log, ""]);
      t.m.teardown();
    }
  });

  test("I7: 同一块里 Ctrl+Z 前后的事件照常送达；挂起期间写入的字节在 SIGCONT 后交出", async () => {
    const t = setup();
    await t.ready();
    t.s.stdin.write(`${E}[A${E}[122;5u${E}[B`);
    await tick();
    expect(kills).toEqual(["SIGSTOP"]);
    expect(t.log).toEqual([
      ["", false, false],
      ["", false, false],
    ]);
    t.log.length = 0;
    t.s.stdin.write("q");
    await tick();
    expect(t.log).toEqual([]);
    await cont();
    expect(t.log).toEqual([["q", false, false]]);
    t.m.teardown();
  });

  test("I7: 重开序列同步写出，SIGCONT 返回时已在流里", async () => {
    const t = setup();
    await t.ready();
    t.s.stdin.write("\x1a");
    await tick();
    t.take();
    process.emit("SIGCONT" as never);
    await new Promise((r) => process.nextTick(r));
    expect(t.take()).toBe(CONT_BASE + CONT_TTY);
    t.m.teardown();
  });

  test("I7: 连按两次：第二次在 SIGCONT 之前不再动作；恢复后可以再次挂起", async () => {
    const t = setup();
    await t.ready();
    t.s.stdin.write("\x1a");
    await tick();
    t.take();
    t.s.stdin.write("\x1a");
    await tick();
    expect(t.take()).toBe("");
    expect(kills).toEqual(["SIGSTOP"]);
    // 第一次 SIGCONT：恢复后立刻读到缓冲的第二个 Ctrl+Z，再挂起
    await cont();
    expect(t.take()).toBe(CONT_BASE + CONT_TTY + STOP_BASE + STOP_TTY);
    expect(kills).toEqual(["SIGSTOP", "SIGSTOP"]);
    expect(t.s.stdin.isRaw).toBe(false);
    await cont();
    expect(t.take()).toBe(CONT_BASE + CONT_TTY);
    expect(t.s.stdin.isRaw).toBe(true);
    t.m.teardown();
  });

  test("I7: 挂起期间卸载：不再碰 stdin；之后的 SIGCONT 什么都不做", async () => {
    for (const two of [false, true]) {
      const s = ttyStreams();
      const calls: string[] = [];
      const st = s.stdin as unknown as Record<string, (...a: unknown[]) => unknown>;
      const raw = st.setRawMode!.bind(s.stdin);
      const unref = st.unref!;
      Object.assign(s.stdin, {
        setRawMode: (v: boolean) => (calls.push(`raw:${v}`), raw(v)),
        unref: () => (calls.push("unref"), unref()),
      });
      function C() {
        useInput(() => {});
        if (two) useInput(() => {});
        return <Text>x</Text>;
      }
      const m = mountTTY(<C />, s);
      await tick();
      s.stdin.write("\x1a");
      await tick();
      const before = process.listenerCount("SIGCONT");
      calls.length = 0;
      (s.stdout as unknown as { isTTY: boolean }).isTTY = false;
      m.inst.unmount();
      forgetRenderInstance(s.stdout);
      await tick();
      expect(calls).toEqual([]);
      expect(s.stdin.listenerCount("readable")).toBe(0);
      // 底座自己的 SIGCONT 监听摘了，一次性的那条还挂着
      expect(process.listenerCount("SIGCONT") - before).toBe(-1);
      s.clear();
      await cont();
      expect(calls).toEqual([]);
      expect(s.stdin.isRaw).toBe(false);
    }
  });

  test("I7: 只挂 internal_eventEmitter（手动 setRawMode）也挂起，Ctrl+Z 不交给监听", async () => {
    const s = ttyStreams();
    const log: unknown[] = [];
    function C() {
      const { internal_eventEmitter: em, setRawMode } = useStdin() as unknown as {
        internal_eventEmitter: NodeJS.EventEmitter;
        setRawMode: (b: boolean) => void;
      };
      React.useEffect(() => {
        setRawMode(true);
        const f = (e: { input: string }) => log.push(e.input);
        em.on("input", f);
        return () => {
          em.off("input", f);
          setRawMode(false);
        };
      }, []);
      return <Text>x</Text>;
    }
    const m = mountTTY(<C />, s);
    await tick();
    s.stdin.write("\x1a");
    await tick();
    expect(kills).toEqual(["SIGSTOP"]);
    expect(log).toEqual([]);
    await cont();
    expect(s.stdin.isRaw).toBe(true);
    m.teardown();
  });
});
