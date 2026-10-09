/**
 * 契约 I1c / I5 / X4 的边界（B9 / T5.1d）：stdin 静默后的模式重申、`drainStdin`、`detachForShutdown`。
 *
 * 主断言在 `contracts-runtime.test.tsx`，这里补探针测出的细节。两套底座都跑。
 * 期望值全部是 2026-10-08 对拍 legacy 的黑盒探针实测（`_probe_misc / w / i1c / i1c2 / i1c3 / x4 / x4b / x4c / fd`），
 * 没有读旧底座代码（设计文档 D-5）。
 */
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import React, { useState } from "react";
import { Text } from "@sid-code/cli/ui/render-port/components.ts";
import { useInput } from "@sid-code/cli/ui/render-port/hooks.ts";
import { drainStdin } from "@sid-code/cli/ui/render-port/runtime.ts";
import { forgetRenderInstance } from "@sid-code/cli/ui/render-port/testing.ts";
import { ENABLE_MOUSE, mountTTY, tick, ttyStreams } from "./tty-streams.ts";

const MOUSE_ALL = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?1007h";

/** 给假 stdin 的 `setRawMode` / `read` / `unref` 记账 */
function record(s: ReturnType<typeof ttyStreams>) {
  const calls: string[] = [];
  const raw = s.stdin.setRawMode.bind(s.stdin);
  const read = s.stdin.read.bind(s.stdin);
  const unref = s.stdin.unref;
  Object.assign(s.stdin, {
    setRawMode: (v: boolean) => {
      calls.push(`raw:${v}`);
      return raw(v);
    },
    read: (...a: [number?]) => {
      const r = read(...a);
      calls.push(`read:${r === null ? "null" : String(r).length}`);
      return r;
    },
    unref: () => {
      calls.push("unref");
      return unref();
    },
  });
  return { calls, raw };
}

function Keys({ log }: { log?: string[] }) {
  useInput((i) => log?.push(i));
  return <Text>k</Text>;
}

/** 把 Date.now 钉在一个可推进的时钟上 */
function fakeClock() {
  let t = 1_000_000_000;
  const spy = spyOn(Date, "now").mockImplementation(() => t);
  return {
    advance: (ms: number) => {
      t += ms;
    },
    restore: () => spy.mockRestore(),
  };
}

function detachTeardown(s: ReturnType<typeof ttyStreams>, unmount: () => void) {
  (s.stdout as unknown as { isTTY: boolean }).isTTY = false;
  unmount();
  forgetRenderInstance(s.stdout);
}

describe("I5 drainStdin 细节", () => {
  test("I5: 原本不在 raw mode → 先读空，再 raw:true / raw:false 走一遍，结束时仍不在 raw mode", () => {
    const s = ttyStreams();
    const { calls } = record(s);
    s.stdin.pause();
    s.stdin.push("abc");
    s.stdin.push("defg");
    drainStdin(s.stdin);
    expect(calls).toEqual(["read:3", "read:4", "read:null", "raw:true", "raw:false"]);
    expect(s.stdin.isRaw).toBe(false);
    expect(s.stdin.readableLength).toBe(0);
    expect(s.stdin.readableFlowing).toBe(false);
  });

  test("I5: 原本在 raw mode → 只读空，不碰 raw mode", () => {
    const s = ttyStreams();
    const { calls, raw } = record(s);
    raw(true);
    s.stdin.pause();
    s.stdin.push("abc");
    drainStdin(s.stdin);
    expect(calls).toEqual(["read:3", "read:null"]);
    expect(s.stdin.isRaw).toBe(true);
  });

  test("I5: setRawMode 抛错 → 吞掉，不往外抛", () => {
    const s = ttyStreams();
    const calls: string[] = [];
    Object.assign(s.stdin, {
      setRawMode: (v: boolean) => {
        calls.push(`raw:${v}`);
        throw new Error("EIO");
      },
    });
    s.stdin.pause();
    s.stdin.push("abc");
    expect(() => drainStdin(s.stdin)).not.toThrow();
    expect(calls).toEqual(["raw:true", "raw:false"]);
    expect(s.stdin.readableLength).toBe(0);
  });

  test("I5: 空缓冲、已销毁的流都不抛", () => {
    const s = ttyStreams();
    s.stdin.pause();
    expect(() => drainStdin(s.stdin)).not.toThrow();
    s.stdin.destroy();
    expect(() => drainStdin(s.stdin)).not.toThrow();
  });

  test("I5: 挂着 data 监听时，读掉的字节照样送到 data 监听（read() 本身的语义），流保持暂停", async () => {
    const s = ttyStreams();
    const log: string[] = [];
    s.stdin.on("data", (d) => log.push(String(d)));
    s.stdin.pause();
    s.stdin.push("abc");
    drainStdin(s.stdin);
    await tick();
    expect(log).toEqual(["abc"]);
    expect(s.stdin.readableFlowing).toBe(false);
  });

  test("I5: 不经 fd 直读 —— fd 上未进流缓冲的字节原样留着", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "sid-t51d-"));
    const file = join(dir, "fd.txt");
    fs.writeFileSync(file, "0123456789");
    const fd = fs.openSync(file, "r");
    try {
      const s = ttyStreams();
      Object.assign(s.stdin, { fd });
      s.stdin.pause();
      drainStdin(s.stdin);
      const buf = Buffer.alloc(20);
      expect(fs.readSync(fd, buf, 0, 20, null)).toBe(10);
    } finally {
      fs.closeSync(fd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("I5: readSync 报 EAGAIN 也不影响（根本不调 readSync）", () => {
    const s = ttyStreams();
    Object.assign(s.stdin, { fd: 987 });
    const seen: unknown[] = [];
    const rs = spyOn(fs, "readSync").mockImplementation(((...a: unknown[]) => {
      seen.push(a[0]);
      throw Object.assign(new Error("EAGAIN"), { code: "EAGAIN" });
    }) as never);
    try {
      s.stdin.pause();
      s.stdin.push("abc");
      expect(() => drainStdin(s.stdin)).not.toThrow();
      expect(seen).toEqual([]);
      expect(s.stdin.readableLength).toBe(0);
    } finally {
      rs.mockRestore();
    }
  });
});

describe("X4 detachForShutdown 细节", () => {
  test("X4: 先 drain 后关 raw mode；不 unref、不摘 readable / SIGCONT / resize，exit promise 不结算", async () => {
    const s = ttyStreams();
    let setN: (n: number) => void = () => {};
    function C() {
      const [n, set] = useState(0);
      setN = set;
      useInput(() => {});
      return <Text>n={n}</Text>;
    }
    const m = mountTTY(<C />, s);
    await tick();
    const { calls } = record(s);
    s.stdin.pause();
    s.stdin.push("zz");
    const before = {
      sigcont: process.listenerCount("SIGCONT"),
      resize: s.stdout.listenerCount("resize"),
      readable: s.stdin.listenerCount("readable"),
    };
    setN(5); // 提交已排队但还没出帧
    s.clear();
    m.ink.detachForShutdown();
    expect(calls).toEqual(["read:2", "read:null", "raw:false"]);
    expect({
      sigcont: process.listenerCount("SIGCONT"),
      resize: s.stdout.listenerCount("resize"),
      readable: s.stdin.listenerCount("readable"),
    }).toEqual(before);
    setN(7);
    await tick(50);
    expect(s.out()).toBe("");
    let exited = "pending";
    m.inst.waitUntilExit().then(
      () => (exited = "resolved"),
      () => (exited = "rejected"),
    );
    await tick();
    expect(exited).toBe("pending");
    detachTeardown(s, () => m.inst.unmount());
  });

  test("X4: 之后的输入照样送到 useInput（readable 读者还挂着）", async () => {
    const s = ttyStreams();
    const log: string[] = [];
    const m = mountTTY(<Keys log={log} />, s);
    await tick();
    m.ink.detachForShutdown();
    s.stdin.write("q");
    await tick();
    expect(log).toEqual(["q"]);
    expect(s.stdin.isRaw).toBe(false);
    detachTeardown(s, () => m.inst.unmount());
  });

  test("X4: 可重复调用；第二次起 drain 走「原本不在 raw mode」分支（raw:true / raw:false）", async () => {
    const s = ttyStreams();
    const m = mountTTY(<Keys />, s);
    await tick();
    const { calls } = record(s);
    m.ink.detachForShutdown();
    calls.push("|");
    m.ink.detachForShutdown();
    expect(calls).toEqual(["read:null", "raw:false", "|", "read:null", "raw:true", "raw:false"]);
    detachTeardown(s, () => m.inst.unmount());
  });

  test("X4: 没有组件开 raw mode 时也照样 drain", async () => {
    const s = ttyStreams();
    const m = mountTTY(<Text>x</Text>, s);
    await tick();
    const { calls } = record(s);
    s.stdin.pause();
    s.stdin.push("ab");
    m.ink.detachForShutdown();
    expect(calls).toEqual(["read:2", "read:null", "raw:true", "raw:false"]);
    expect(s.stdin.readableLength).toBe(0);
    detachTeardown(s, () => m.inst.unmount());
  });

  test("X4: 非 TTY stdin → 不 drain、不写字节", async () => {
    const s = ttyStreams();
    Object.assign(s.stdin, { isTTY: false });
    const m = mountTTY(<Text>x</Text>, s);
    await tick();
    s.stdin.pause();
    s.stdin.push("ab");
    s.clear();
    m.ink.detachForShutdown();
    expect(s.stdin.readableLength).toBe(2);
    expect(s.out()).toBe("");
    detachTeardown(s, () => m.inst.unmount());
  });
});

describe("I1c 模式重申细节", () => {
  /** alt-screen 开了鼠标跟踪，从挂载起推进 gap 毫秒后输入一次，返回 [这次的输出, 紧接着再输入一次的输出] */
  async function run(gap: number, alt = true, mouse = true) {
    const clock = fakeClock();
    const s = ttyStreams();
    const m = mountTTY(<Keys />, s);
    try {
      await tick();
      if (alt) m.ink.setAltScreenActive(true, mouse);
      clock.advance(gap);
      s.clear();
      s.stdin.write("a");
      await tick();
      const first = s.out();
      s.clear();
      s.stdin.write("b");
      await tick();
      return [first, s.out()];
    } finally {
      clock.restore();
      m.teardown();
    }
  }

  test("I1c: 阈值严格大于 5000ms；重申只写鼠标跟踪全套，紧接着的输入不再写", async () => {
    expect(await run(5000)).toEqual(["", ""]);
    expect(await run(5001)).toEqual([MOUSE_ALL, ""]);
  });

  test("I1c: 主屏、alt-screen 未开鼠标跟踪 → 什么都不写", async () => {
    expect(await run(6000, false)).toEqual(["", ""]);
    expect(await run(6000, true, false)).toEqual(["", ""]);
  });

  test("I1c: 非 TTY stdout → 什么都不写", async () => {
    const clock = fakeClock();
    const s = ttyStreams({ stdoutTTY: false });
    const m = mountTTY(<Keys />, s);
    try {
      await tick();
      m.ink.setAltScreenActive(true, true);
      clock.advance(6000);
      s.clear();
      s.stdin.write("a");
      await tick();
      expect(s.out()).toBe("");
    } finally {
      clock.restore();
      m.teardown();
    }
  });

  test("I1c: 静默从上一块输入算起；同一时刻两块只重申一次；时钟倒退不重申", async () => {
    const clock = fakeClock();
    const s = ttyStreams();
    const m = mountTTY(<Keys />, s);
    try {
      await tick();
      m.ink.setAltScreenActive(true, true);
      clock.advance(3000);
      s.stdin.write("a");
      await tick();
      clock.advance(3000);
      s.clear();
      s.stdin.write("b");
      await tick();
      expect(s.out()).toBe(""); // 距挂载 6s，距上一块 3s
      clock.advance(6000);
      s.clear();
      s.stdin.write("c");
      s.stdin.write("d");
      await tick();
      expect(s.out()).toBe(MOUSE_ALL);
      clock.advance(-10_000);
      s.clear();
      s.stdin.write("e");
      await tick();
      expect(s.out()).toBe("");
    } finally {
      clock.restore();
      m.teardown();
    }
  });

  test("I1c: 起点是挂载时刻，不是打开 raw mode 的时刻", async () => {
    const clock = fakeClock();
    const s = ttyStreams();
    let setOn: (v: boolean) => void = () => {};
    function C() {
      const [on, set] = useState(false);
      setOn = set;
      useInput(() => {}, { isActive: on });
      return <Text>x</Text>;
    }
    const m = mountTTY(<C />, s);
    try {
      await tick();
      m.ink.setAltScreenActive(true, true);
      clock.advance(6000);
      setOn(true);
      await tick();
      s.clear();
      s.stdin.write("a");
      await tick();
      expect(s.out()).toContain(ENABLE_MOUSE);
    } finally {
      clock.restore();
      m.teardown();
    }
  });

  test("I1c: 停用期间缓冲、重新启用时被丢掉的那块也刷新时间戳", async () => {
    const clock = fakeClock();
    const s = ttyStreams();
    let setOn: (v: boolean) => void = () => {};
    function C() {
      const [on, set] = useState(true);
      setOn = set;
      useInput(() => {}, { isActive: on });
      return <Text>x</Text>;
    }
    const m = mountTTY(<C />, s);
    try {
      await tick();
      m.ink.setAltScreenActive(true, true);
      clock.advance(4000);
      setOn(false);
      await tick();
      s.stdin.write("z");
      await tick();
      clock.advance(2000);
      setOn(true); // 这时读到 z（被丢给没人订阅的 emitter），它本身就是静默后的第一块
      await tick();
      s.clear();
      s.stdin.write("a");
      await tick();
      expect(s.out()).toBe("");
    } finally {
      clock.restore();
      m.teardown();
    }
  });
});
