/**
 * 契约 I2（B9 / T5.2b）：终端探查（XTVERSION `ESC[>0q` + DA1 `ESC[c`）与 `setSuppressTerminalProbe`。两套底座都跑。
 *
 * 期望值全部是 2026-10-08 对拍 legacy 的黑盒探针实测（`_probe_i2 … i2g`），没有读旧底座代码（设计文档 D-5）。
 * 只比探查本身的两段写入；raw mode 开关时旁边的 `?2004h` / `?1004h` 属于 I4（T5.3a），这里不比。
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import React, { useState } from "react";
import { Text } from "@sid-code/cli/ui/render-port/components.ts";
import { useInput, useStdin } from "@sid-code/cli/ui/render-port/hooks.ts";
import {
  getRenderInstance,
  setSuppressTerminalProbe,
} from "@sid-code/cli/ui/render-port/runtime.ts";
import { mountTTY, tick, ttyStreams } from "./tty-streams.ts";

const E = "\x1b";
const XTVERSION: string = `${E}[>0q`;
const DA1: string = `${E}[c`;
const isProbe = (c: string) => c === XTVERSION || c === DA1;

afterEach(() => setSuppressTerminalProbe(false));

/** 逐次记录 stdout.write 的入参，探查按「两次独立 write」比较 */
function streams(opts: { stdoutTTY?: boolean } = {}) {
  const s = ttyStreams(opts);
  const writes: string[] = [];
  s.stdout.on("data", (c: Buffer) => writes.push(c.toString()));
  return {
    s,
    writes,
    probes: () => writes.filter(isProbe),
    reset: () => (writes.length = 0),
  };
}

let stdinApi: { setRawMode(v: boolean): void } | undefined;
function Raw() {
  stdinApi = useStdin() as never;
  return <Text>h</Text>;
}
let setActive: (b: boolean) => void = () => {};
function Input({ initial = true, onInput }: { initial?: boolean; onInput?: (i: string) => void }) {
  const [active, set] = useState(initial);
  setActive = set;
  useInput((i) => onInput?.(i), { isActive: active });
  return <Text>hello</Text>;
}
const PAIR: string[] = [XTVERSION, DA1];

describe("I2: 何时探查", () => {
  test("I2: 挂载后 raw mode 0 → 1 时探查一次：首帧之后、两次独立 write、XTVERSION 在前", async () => {
    const t = streams();
    const m = mountTTY(<Input />, t.s);
    await tick();
    expect(t.probes()).toEqual(PAIR);
    const first = t.writes.findIndex(isProbe);
    expect(t.writes.slice(first)).toEqual(PAIR); // 两段是最后两次写，且彼此独立
    expect(t.writes.slice(0, first).join("")).toContain("hello"); // 写在首帧之后
    m.teardown();
  });

  test("I2: 用 setImmediate 推迟：调用返回时、nextTick、微任务里都还没写，下一个 check 阶段才写", async () => {
    const t = streams();
    const m = mountTTY(<Raw />, t.s);
    await tick();
    t.reset();
    const marks: string[] = [];
    stdinApi!.setRawMode(true);
    marks.push(`sync:${t.probes().length}`);
    process.nextTick(() => marks.push(`nextTick:${t.probes().length}`));
    queueMicrotask(() => marks.push(`micro:${t.probes().length}`));
    setImmediate(() => marks.push(`immediate:${t.probes().length}`));
    await tick();
    expect(marks).toEqual(["sync:0", "micro:0", "nextTick:0", "immediate:2"]);
    m.teardown();
  });

  test("I2: 没有组件开 raw mode 就不探查", async () => {
    const t = streams();
    const m = mountTTY(<Text>hello</Text>, t.s);
    await tick(50);
    expect(t.probes()).toEqual([]);
    m.teardown();
  });

  test("I2: stdout 非 TTY 照样探查；stdin 非 TTY（raw mode 不可用、setRawMode 抛错）不探查", async () => {
    const a = streams({ stdoutTTY: false });
    const m = mountTTY(<Input />, a.s);
    await tick();
    expect(a.probes()).toEqual(PAIR);
    m.teardown();

    // 挂载前就设非 TTY：挂载后再改 isTTY 时两套底座判定时机不同（legacy 调用时读、next 挂载时读），不归 I2
    const b = streams();
    (b.s.stdin as unknown as { isTTY: boolean }).isTTY = false;
    const m2 = mountTTY(<Raw />, b.s);
    await tick();
    expect(() => stdinApi!.setRawMode(true)).toThrow(/Raw mode is not supported/);
    await tick();
    expect(b.probes()).toEqual([]);
    m2.teardown();
  });

  test("I2: 每次计数从 0 变 1 都探查（isActive 关了再开）；计数 1 → 2 不探查", async () => {
    const t = streams();
    const m = mountTTY(<Input initial={false} />, t.s);
    await tick();
    expect(t.probes()).toEqual([]);
    setActive(true);
    await tick();
    expect(t.probes()).toEqual(PAIR);
    setActive(false);
    await tick();
    expect(t.probes()).toEqual(PAIR);
    setActive(true);
    await tick();
    expect(t.probes()).toEqual([...PAIR, ...PAIR]);
    t.reset();
    stdinApi = undefined;
    m.teardown();

    const u = streams();
    const m2 = mountTTY(<Raw />, u.s);
    await tick();
    stdinApi!.setRawMode(true);
    stdinApi!.setRawMode(true);
    await tick();
    expect(u.probes()).toEqual(PAIR);
    m2.teardown();
  });

  test("I2: 同一同步段里开关两次，排几次发几次；开了又在发出前关掉，照样发", async () => {
    const t = streams();
    const m = mountTTY(<Raw />, t.s);
    await tick();
    stdinApi!.setRawMode(true);
    await tick();
    t.reset();
    stdinApi!.setRawMode(false);
    stdinApi!.setRawMode(true);
    stdinApi!.setRawMode(false);
    stdinApi!.setRawMode(true);
    await tick();
    expect(t.probes()).toEqual([...PAIR, ...PAIR]);
    t.reset();
    stdinApi!.setRawMode(false);
    await tick();
    stdinApi!.setRawMode(true);
    await Promise.resolve();
    stdinApi!.setRawMode(false);
    await tick();
    expect(t.probes()).toEqual(PAIR);
    m.teardown();
  });

  test("I2: 排了就发：发出前卸载、detachForShutdown 都不取消", async () => {
    const a = streams();
    const m = mountTTY(<Raw />, a.s);
    await tick();
    stdinApi!.setRawMode(true);
    m.teardown();
    await tick();
    expect(a.probes()).toEqual(PAIR);

    const b = streams();
    const m2 = mountTTY(<Raw />, b.s);
    await tick();
    stdinApi!.setRawMode(true);
    getRenderInstance(b.s.stdout)!.detachForShutdown();
    await tick();
    expect(b.probes()).toEqual(PAIR);
    m2.teardown();
  });

  test("I2: 同一 stdout 上前一个实例卸载后，新实例重新探查", async () => {
    const t = streams();
    const m = mountTTY(<Input />, t.s);
    await tick();
    m.teardown();
    (t.s.stdout as unknown as { isTTY: boolean }).isTTY = true;
    t.reset();
    const m2 = mountTTY(<Input />, t.s);
    await tick();
    expect(t.probes()).toEqual(PAIR);
    m2.teardown();
  });
});

describe("I2: 回复与超时", () => {
  test("I2: 回复被丢弃（I3），不进 useInput；data 读者照收原始字节；之后不再写任何东西", async () => {
    const t = streams();
    const got: string[] = [];
    const data: string[] = [];
    t.s.stdin.on("data", (c: Buffer) => data.push(c.toString()));
    const m = mountTTY(<Input onInput={(i) => got.push(i)} />, t.s);
    await tick();
    t.reset();
    const reply = `${E}P>|kitty(0.40)${E}\\${E}[?62;22c`;
    t.s.stdin.write(reply);
    t.s.stdin.write("a");
    await tick();
    expect(got).toEqual(["a"]);
    expect(data.join("")).toBe(`${reply}a`);
    expect(t.writes).toEqual([]);
    m.teardown();
  });

  test("I2: 不回复也不重发、不超时", async () => {
    const t = streams();
    const m = mountTTY(<Input />, t.s);
    await tick();
    t.reset();
    await tick(1200);
    expect(t.writes).toEqual([]);
    m.teardown();
  });
});

describe("I2: setSuppressTerminalProbe", () => {
  test("I2: 置真后挂载的实例不探查，再开关 raw mode 也不探查", async () => {
    setSuppressTerminalProbe(true);
    const t = streams();
    const m = mountTTY(<Input />, t.s);
    await tick();
    setActive(false);
    await tick();
    setActive(true);
    await tick();
    expect(t.probes()).toEqual([]);
    m.teardown();
  });

  test("I2: 抑制在排队时判定：已排上的照发；抑制期间排的，同步解除也不补发", async () => {
    const a = streams();
    const m = mountTTY(<Raw />, a.s);
    await tick();
    stdinApi!.setRawMode(true);
    setSuppressTerminalProbe(true);
    await tick();
    expect(a.probes()).toEqual(PAIR);
    setSuppressTerminalProbe(false);
    m.teardown();

    const b = streams();
    const m2 = mountTTY(<Raw />, b.s);
    await tick();
    setSuppressTerminalProbe(true);
    stdinApi!.setRawMode(true);
    setSuppressTerminalProbe(false);
    await tick();
    expect(b.probes()).toEqual([]);
    m2.teardown();
  });

  test("I2: 已挂载实例上解除抑制：不补发，下一次 0 → 1 才探查", async () => {
    setSuppressTerminalProbe(true);
    const t = streams();
    const m = mountTTY(<Input />, t.s);
    await tick();
    setSuppressTerminalProbe(false);
    await tick();
    expect(t.probes()).toEqual([]);
    setActive(false);
    await tick();
    setActive(true);
    await tick();
    expect(t.probes()).toEqual(PAIR);
    m.teardown();
  });

  test("I2: 置真再置假后挂载，正常探查（开关是进程级的当前值）", async () => {
    setSuppressTerminalProbe(true);
    setSuppressTerminalProbe(false);
    const t = streams();
    const m = mountTTY(<Input />, t.s);
    await tick();
    expect(t.probes()).toEqual(PAIR);
    m.teardown();
  });
});

describe("I2: Ctrl+Z 恢复", () => {
  const killSpy = () =>
    spyOn(process, "kill").mockImplementation((() => true) as never) as ReturnType<typeof spyOn>;

  test("I2: SIGCONT 恢复且计数 > 0 时再探查一次，写在重开序列之后、setImmediate 推迟", async () => {
    const k = killSpy();
    const t = streams();
    const m = mountTTY(<Input />, t.s);
    await tick();
    t.s.stdin.write("\x1a");
    await tick();
    t.reset();
    process.emit("SIGCONT" as never);
    expect(t.probes()).toEqual([]);
    const marks: string[] = [];
    queueMicrotask(() => marks.push(`micro:${t.probes().length}`));
    setImmediate(() => marks.push(`immediate:${t.probes().length}`));
    await tick();
    expect(marks).toEqual(["micro:0", "immediate:2"]);
    expect(t.writes.slice(-2)).toEqual(PAIR);
    k.mockRestore();
    m.teardown();
  });

  test("I2: 挂起期间计数降到 0，恢复时不探查；抑制中恢复也不探查", async () => {
    const k = killSpy();
    const a = streams();
    const m = mountTTY(<Input />, a.s);
    await tick();
    a.s.stdin.write("\x1a");
    await tick();
    setActive(false);
    await tick();
    a.reset();
    process.emit("SIGCONT" as never);
    await tick();
    expect(a.probes()).toEqual([]);
    m.teardown();

    const b = streams();
    const m2 = mountTTY(<Input />, b.s);
    await tick();
    b.s.stdin.write("\x1a");
    await tick();
    b.reset();
    setSuppressTerminalProbe(true);
    process.emit("SIGCONT" as never);
    await tick();
    expect(b.probes()).toEqual([]);
    k.mockRestore();
    m2.teardown();
  });

  test("I2: 没挂起时收到 SIGCONT 不探查", async () => {
    const t = streams();
    const m = mountTTY(<Input />, t.s);
    await tick();
    t.reset();
    process.emit("SIGCONT" as never);
    await tick();
    expect(t.probes()).toEqual([]);
    m.teardown();
  });
});
