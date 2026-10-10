/**
 * 契约 I9 / I10 / I11（B9 / T5.1c）：stdin 所有权、raw mode 引用计数、`internal_eventEmitter` 事件形状。
 *
 * 两套底座都跑。期望值全部是 2026-10-07/08 对拍 legacy 的黑盒探针实测（`_probe_raw / raw2 / u / v / x / y / s / t`，
 * 结果备份在 `~/Backups/sid-code-t51-probe-results-20261007/`），没有读旧底座代码（设计文档 D-5）。
 */
import { describe, expect, spyOn, test } from "bun:test";
import React, { useEffect, useLayoutEffect, useState } from "react";
import { Text } from "@sid-code/cli/ui/render-port/components.ts";
import { useApp, useInput, useStdin } from "@sid-code/cli/ui/render-port/hooks.ts";
import { forgetRenderInstance } from "@sid-code/cli/ui/render-port/testing.ts";
import { mountTTY, tick, ttyStreams } from "./tty-streams.ts";

/** 记录 `setRawMode` / `ref` / `unref` 调用顺序的假 TTY */
function recorded() {
  const s = ttyStreams({ stdoutTTY: false });
  const calls: string[] = [];
  const orig = s.stdin.setRawMode.bind(s.stdin);
  Object.assign(s.stdin, {
    setRawMode: (v: boolean) => {
      calls.push(`raw:${v}`);
      return orig(v);
    },
    ref: () => {
      calls.push("ref");
      return s.stdin;
    },
    unref: () => {
      calls.push("unref");
      return s.stdin;
    },
  });
  /** [本段调用, isRaw, readable 监听数]，取完清空调用记录 */
  const snap = () => [calls.splice(0), s.stdin.isRaw, s.stdin.listenerCount("readable")];
  return { s, calls, snap };
}

type StdinApi = ReturnType<typeof useStdin> & {
  internal_eventEmitter: import("node:events").EventEmitter;
};

const trueKeys = (k: object) =>
  Object.entries(k)
    .filter(([, v]) => v === true)
    .map(([n]) => n)
    .sort()
    .join(",");

describe("I9 raw mode 引用计数", () => {
  test("I9: 多个 useInput 共用一份计数，最后一个卸载才关；手动 setRawMode 同步生效，关不经微任务", async () => {
    const { s, snap } = recorded();
    let api!: StdinApi;
    let setA!: (v: boolean) => void;
    let setB!: (v: boolean) => void;
    function A() {
      useInput(() => {});
      return null;
    }
    function Root() {
      const [a, sa] = useState(true);
      const [b, sb] = useState(true);
      setA = sa;
      setB = sb;
      api = useStdin() as StdinApi;
      return (
        <>
          {a ? <A /> : null}
          {b ? <A /> : null}
          <Text>x</Text>
        </>
      );
    }
    const m = mountTTY(<Root />, s);
    await tick();
    const steps: unknown[] = [["mounted", ...snap()]];
    setA(false);
    await tick();
    steps.push(["A off", ...snap()]);
    setB(false);
    await tick();
    steps.push(["B off", ...snap()]);
    api.setRawMode(true);
    steps.push(["manual on sync", ...snap()]);
    api.setRawMode(true);
    api.setRawMode(false);
    await tick();
    steps.push(["on/off", ...snap()]);
    api.setRawMode(false);
    steps.push(["off sync", ...snap()]);
    m.teardown();
    steps.push(["unmount", ...snap()]);
    expect(steps).toEqual([
      ["mounted", ["ref", "raw:true"], true, 1],
      ["A off", [], true, 1],
      ["B off", ["raw:false", "unref"], false, 0],
      ["manual on sync", ["ref", "raw:true"], true, 1],
      ["on/off", [], true, 1],
      ["off sync", ["raw:false", "unref"], false, 0],
      ["unmount", [], false, 0],
    ]);
  });

  test("I9: 计数会被多余的 false 压成负数，之后要补回同样多次 true 才真正打开", async () => {
    const { s, snap } = recorded();
    let api!: StdinApi;
    let setA!: (v: boolean) => void;
    function A() {
      useInput(() => {});
      return null;
    }
    function R() {
      api = useStdin() as StdinApi;
      const [a, sa] = useState(false);
      setA = sa;
      return (
        <>
          {a ? <A /> : null}
          <Text>x</Text>
        </>
      );
    }
    const m = mountTTY(<R />, s);
    await tick();
    api.setRawMode(false);
    api.setRawMode(false);
    const steps: unknown[] = [["-2", ...snap()]];
    // 计数为负时挂 useInput 也不开（-2 → -1）
    setA(true);
    await tick();
    steps.push(["hook on", ...snap()]);
    api.setRawMode(true);
    steps.push(["0", ...snap()]);
    api.setRawMode(true);
    steps.push(["1", ...snap()]);
    api.setRawMode(false);
    steps.push(["0 again", ...snap()]);
    m.teardown();
    expect(steps).toEqual([
      ["-2", [], false, 0],
      ["hook on", [], false, 0],
      ["0", [], false, 0],
      ["1", ["ref", "raw:true"], true, 1],
      ["0 again", ["raw:false", "unref"], false, 0],
    ]);
  });

  test("I9: 同一提交里换一个 useInput 组件 → 先关后开，切换前缓冲的半截转义冲刷给新组件", async () => {
    const { s, snap } = recorded();
    const log: string[] = [];
    let set!: (v: string) => void;
    function A() {
      useInput((i) => log.push("A" + i));
      return <Text>A</Text>;
    }
    function B() {
      useInput((i) => log.push("B" + i));
      return <Text>B</Text>;
    }
    function R() {
      const [w, sw] = useState("A");
      set = sw;
      return w === "A" ? <A /> : <B />;
    }
    const m = mountTTY(<R />, s);
    await tick();
    snap();
    set("B");
    await tick();
    s.stdin.write("q");
    await tick();
    const swap = snap();
    s.stdin.write("\x1b[");
    await tick(5);
    set("A");
    await tick(60);
    s.stdin.write("z");
    await tick();
    const pending = snap();
    m.teardown();
    expect(swap).toEqual([["raw:false", "unref", "ref", "raw:true"], true, 1]);
    expect(pending[0]).toEqual(["raw:false", "unref", "ref", "raw:true"]);
    expect(log).toEqual(["Bq", "A[", "Az"]);
  });

  test("I9: 卸载时 raw mode 开着 → 同步关掉、摘掉 readable", async () => {
    const { s, snap } = recorded();
    function A() {
      useInput(() => {});
      return <Text>A</Text>;
    }
    const m = mountTTY(<A />, s);
    await tick();
    snap();
    (s.stdout as unknown as { isTTY: boolean }).isTTY = false;
    m.inst.unmount();
    const sync = snap();
    await tick();
    const later = snap();
    forgetRenderInstance(s.stdout);
    expect(sync).toEqual([["raw:false", "unref"], false, 0]);
    expect(later).toEqual([[], false, 0]);
  });

  test("I9: stdin 不是 TTY → isRawModeSupported=false，setRawMode 抛错", async () => {
    const s = ttyStreams({ stdoutTTY: false });
    (s.stdin as unknown as { isTTY: boolean }).isTTY = false;
    let api!: StdinApi;
    function C() {
      api = useStdin() as StdinApi;
      return <Text>z</Text>;
    }
    const m = mountTTY(<C />, s);
    await tick();
    expect(api.isRawModeSupported).toBe(false);
    expect(() => api.setRawMode(true)).toThrow(
      "Raw mode is not supported on the stdin provided to Ink",
    );
    m.teardown();
  });

  test("I9: useApp().exit(err) 让 waitUntilExit reject，exit() 让它 resolve", async () => {
    const results: string[] = [];
    for (const arg of [new Error("bye"), undefined]) {
      const s = ttyStreams({ stdoutTTY: false });
      let app!: ReturnType<typeof useApp>;
      function A() {
        app = useApp();
        return <Text>A</Text>;
      }
      const m = mountTTY(<A />, s);
      await tick();
      let res = "pending";
      m.inst.waitUntilExit().then(
        (v: unknown) => (res = "resolve:" + JSON.stringify(v ?? null)),
        (e: Error) => (res = "reject:" + e.message),
      );
      app.exit(arg);
      await tick();
      results.push(res);
      forgetRenderInstance(s.stdout);
    }
    expect(results).toEqual(["reject:bye", "resolve:null"]);
  });
});

describe("I10 isActive 切换与缓冲字节", () => {
  test("I10: isActive=false 时关 raw mode、摘 readable；重新启用后才开", async () => {
    const { s, snap } = recorded();
    const log: string[] = [];
    let set!: (v: boolean) => void;
    function A() {
      const [on, so] = useState(true);
      set = so;
      useInput((i) => log.push(i), { isActive: on });
      return <Text>A</Text>;
    }
    const m = mountTTY(<A />, s);
    await tick();
    snap();
    set(false);
    await tick();
    expect(snap()).toEqual([["raw:false", "unref"], false, 0]);
    m.teardown();
  });

  // 非活跃期间到达的字节留在流里；重新启用时 readable 立即把它们交出，而此时 handler 还没挂上（raw mode 在
  // layout effect 里开、handler 在 passive effect 里挂），所以这些字节被丢掉，只有之后的输入送达
  for (const mode of ["isActive", "remount"] as const)
    for (const gap of [0, 30])
      for (const payload of ["q", "\x1b[A"]) {
        test(`I10: ${mode} 停用期间写入 ${JSON.stringify(payload)}（间隔 ${gap}ms）→ 重新启用后被丢弃`, async () => {
          const s = ttyStreams({ stdoutTTY: false });
          const log: string[] = [];
          let set!: (v: boolean) => void;
          const h = (i: string, k: { upArrow: boolean }) => log.push(k.upArrow ? "UP" : i);
          function K() {
            useInput(h);
            return null;
          }
          function A() {
            const [on, so] = useState(true);
            set = so;
            useInput(h, { isActive: on });
            return <Text>A</Text>;
          }
          function R() {
            const [on, so] = useState(true);
            set = so;
            return (
              <>
                {on ? <K /> : null}
                <Text>r</Text>
              </>
            );
          }
          const m = mountTTY(mode === "isActive" ? <A /> : <R />, s);
          await tick();
          set(false);
          await tick();
          s.stdin.write(payload);
          if (gap) await tick(gap);
          const buffered = s.stdin.readableLength;
          set(true);
          await tick();
          s.stdin.write("z");
          await tick();
          m.teardown();
          expect(buffered).toBe(payload.length);
          expect(log).toEqual(["z"]);
          expect(s.stdin.readableLength).toBe(0);
        });
      }

  test("I10: 停用期间写入、同一 tick 内重新启用 → 同样丢弃", async () => {
    const s = ttyStreams({ stdoutTTY: false });
    const log: string[] = [];
    let set!: (v: boolean) => void;
    function A() {
      const [on, so] = useState(true);
      set = so;
      useInput((i) => log.push(i), { isActive: on });
      return <Text>A</Text>;
    }
    const m = mountTTY(<A />, s);
    await tick();
    set(false);
    await tick();
    s.stdin.write("q");
    s.stdin.write("w");
    set(true);
    await tick();
    m.teardown();
    expect(log).toEqual([]);
    expect(s.stdin.readableLength).toBe(0);
  });

  test("I10: 首次挂载前已缓冲的字节（push 或 write）照常送达", async () => {
    const got: string[][] = [];
    for (const how of ["push", "write"] as const) {
      const s = ttyStreams({ stdoutTTY: false });
      const log: string[] = [];
      if (how === "push") {
        s.stdin.pause();
        s.stdin.push("pre");
      } else {
        s.stdin.write("pre");
        await tick();
      }
      function C() {
        useInput((i) => log.push(i));
        return <Text>x</Text>;
      }
      const m = mountTTY(<C />, s);
      await tick();
      s.stdin.write("z");
      await tick();
      m.teardown();
      got.push(log);
    }
    expect(got).toEqual([
      ["pre", "z"],
      ["pre", "z"],
    ]);
  });

  test("I10: 手动 setRawMode 开着时写入的字节由 emitter 交出，之后挂上的 useInput 只收到挂上之后的", async () => {
    const s = ttyStreams({ stdoutTTY: false });
    const log: string[] = [];
    let api!: StdinApi;
    let set!: (v: boolean) => void;
    function A() {
      useInput((i) => log.push(i));
      return null;
    }
    function R() {
      api = useStdin() as StdinApi;
      const [on, so] = useState(false);
      set = so;
      return (
        <>
          {on ? <A /> : null}
          <Text>r</Text>
        </>
      );
    }
    const m = mountTTY(<R />, s);
    await tick();
    api.setRawMode(true);
    await tick();
    s.stdin.write("q");
    await tick();
    set(true);
    await tick();
    s.stdin.write("w");
    await tick();
    m.teardown();
    expect(log).toEqual(["w"]);
  });

  test("I10: effect 与 handler 的先后：raw mode 跟 layout effect 走，handler 跟 passive effect 走", async () => {
    const s = ttyStreams({ stdoutTTY: false });
    const log: string[] = [];
    let set!: (v: boolean) => void;
    let api!: StdinApi;
    function A() {
      const [on, so] = useState(true);
      set = so;
      api = useStdin() as StdinApi;
      useLayoutEffect(() => {
        log.push("layout:" + on);
      }, [on]);
      useEffect(() => {
        log.push("passive:" + on);
      }, [on]);
      useInput((i) => log.push("handler:" + i), { isActive: on });
      return <Text>A</Text>;
    }
    const m = mountTTY(<A />, s);
    await tick();
    api.internal_eventEmitter.on("input", (e: { input: string }) => log.push("emit:" + e.input));
    const origRaw = s.stdin.setRawMode.bind(s.stdin);
    Object.assign(s.stdin, {
      setRawMode: (v: boolean) => {
        log.push("raw:" + v);
        return origRaw(v);
      },
    });
    set(false);
    await tick();
    s.stdin.write("q");
    await tick();
    log.push("--");
    set(true);
    await tick();
    m.teardown();
    expect(log).toEqual([
      "layout:true",
      "passive:true",
      "raw:false",
      "layout:false",
      "passive:false",
      "--",
      "layout:true",
      "raw:true",
      "emit:q",
      "passive:true",
      "raw:false",
    ]);
  });

  test("I10: 同一块里某个 useInput 回调抛错 → 这块剩下的事件和排在后面的监听者都收不到", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    const s = ttyStreams({ stdoutTTY: false });
    const log: string[] = [];
    function C() {
      useInput((i) => {
        log.push(i);
        if (i === "x") throw new Error("b");
      });
      return <Text>x</Text>;
    }
    function D() {
      useInput((i) => log.push("D" + i));
      return <Text>d</Text>;
    }
    const m = mountTTY(
      <>
        <C />
        <D />
      </>,
      s,
    );
    await tick();
    s.stdin.write("x\x1b[Ab");
    await tick();
    s.stdin.write("c");
    await tick();
    err.mockRestore();
    m.teardown();
    expect(log).toEqual(["x", "c", "Dc"]);
  });
});

describe("I11 internal_eventEmitter 事件形状", () => {
  // 只比 CLI 可能依赖的字段；旧底座 keypress 上还有 name / option / code，新底座不仿造（见 input-event.ts）
  const pick = (e: { keypress: Record<string, unknown> }) => {
    const kp = e.keypress;
    return {
      own: Object.keys(e),
      stop: typeof (e as unknown as { stopImmediatePropagation?: unknown })
        .stopImmediatePropagation,
      keypress: {
        kind: kp.kind,
        ctrl: kp.ctrl,
        meta: kp.meta,
        shift: kp.shift,
        super: kp.super,
        fn: kp.fn,
        sequence: kp.sequence,
        isPasted: kp.isPasted,
      },
    };
  };
  const OWN = ["_didStopImmediatePropagation", "keypress", "key", "input"];
  const kp = (
    sequence: string,
    mods: Partial<Record<"ctrl" | "meta" | "shift" | "super", boolean>> = {},
    isPasted = false,
  ) => ({
    kind: "key",
    ctrl: false,
    meta: false,
    shift: false,
    super: false,
    fn: false,
    ...mods,
    sequence,
    isPasted,
  });
  const CASES: [string, ReturnType<typeof kp>, string, string][] = [
    ["q", kp("q"), "q", ""],
    ["Q", kp("Q", { shift: true }), "Q", "shift"],
    ["pre", kp("pre"), "pre", ""],
    ["\x1b[A", kp("\x1b[A"), "", "upArrow"],
    ["\r", kp("\r"), "", "return"],
    ["\x1b[Z", kp("\x1b[Z", { shift: true }), "", "shift,tab"],
    ["\x01", kp("\x01", { ctrl: true }), "a", "ctrl"],
    ["\x1bb", kp("\x1bb", { meta: true }), "", "leftArrow,meta"],
    ["\x1b[1;5A", kp("\x1b[1;5A", { ctrl: true }), "", "ctrl,upArrow"],
    ["\x1b[97;9u", kp("\x1b[97;9u", { super: true }), "a", "super"],
    ["\x1b[13;2u", kp("\x1b[13;2u", { shift: true }), "return", "return,shift"],
    ["\x1b[200~hi\x1b[201~", kp("hi", {}, true), "hi", ""],
  ];
  for (const [seq, keypress, input, keys] of CASES) {
    test(`I11: ${JSON.stringify(seq)} → keypress.sequence=${JSON.stringify(keypress.sequence)}，input=${JSON.stringify(input)}，key={${keys}}`, async () => {
      const s = ttyStreams({ stdoutTTY: false });
      let api!: StdinApi;
      const got: unknown[] = [];
      function C() {
        api = useStdin() as StdinApi;
        useInput(() => {});
        return <Text>x</Text>;
      }
      const m = mountTTY(<C />, s);
      await tick();
      api.internal_eventEmitter.on(
        "input",
        (e: { keypress: Record<string, unknown>; input: string; key: object }) =>
          got.push([pick(e), e.input, trueKeys(e.key)]),
      );
      s.stdin.write(seq);
      await tick(80);
      m.teardown();
      expect(got).toEqual([[{ own: OWN, stop: "function", keypress }, input, keys]]);
    });
  }

  test("I11: 监听者按挂载顺序收到；某个监听者 stopImmediatePropagation() 后，后面的（含 useInput）都收不到", async () => {
    const s = ttyStreams({ stdoutTTY: false });
    let api!: StdinApi;
    const log: string[] = [];
    function A() {
      useInput((i) => log.push("hook:" + i));
      return null;
    }
    function R() {
      api = useStdin() as StdinApi;
      return (
        <>
          <A />
          <Text>x</Text>
        </>
      );
    }
    const m = mountTTY(<R />, s);
    await tick();
    const em = api.internal_eventEmitter;
    // emitter 上只有使用方自己挂的监听（底座内部的 Tab 导航不占位）
    expect(em.listenerCount("input")).toBe(1);
    em.on("input", () => log.push("ext"));
    em.prependListener("input", () => log.push("pre"));
    s.stdin.write("q");
    await tick();
    em.prependListener("input", (e: { stopImmediatePropagation(): void }) => {
      log.push("stop");
      e.stopImmediatePropagation();
    });
    s.stdin.write("w");
    await tick();
    m.teardown();
    expect(log).toEqual(["pre", "hook:q", "ext", "stop"]);
  });

  test("I11: 无 useInput、只手动 setRawMode 时同步不出事件，下一个 tick 才交出已缓冲字节", async () => {
    const s = ttyStreams({ stdoutTTY: false });
    s.stdin.pause();
    s.stdin.push("pre");
    let api!: StdinApi;
    const got: string[] = [];
    function R() {
      api = useStdin() as StdinApi;
      return <Text>r</Text>;
    }
    const m = mountTTY(<R />, s);
    await tick();
    api.internal_eventEmitter.on("input", (e: { input: string }) => got.push(e.input));
    api.setRawMode(true);
    const sync = got.slice();
    await tick();
    m.teardown();
    expect(sync).toEqual([]);
    expect(got).toEqual(["pre"]);
  });
});
