/**
 * Esc 双击打开会话回退的**接线测试**（A1：空闲时双击 Esc 无响应）
 *
 * ## 为什么这样测
 * 修复的核心不是"有没有一个判定函数"，而是**优先级与消费顺序**：单个 `escape` 在
 * 中断 / 关面板 / 关补全 / vim 切模式这些场景都已有语义，必须让它们先消费，且被消费掉的
 * 那一击不能计入双击。这类缺陷纯函数单测全绿也照样存在——必须让真实的
 * `KeypressProvider` 做真实派发。
 *
 * 所以逻辑被抽成 `useRewindEscape`（生产代码，App.tsx 直接用它），这里渲染一个最小宿主
 * 组件挂上它 + 一个模拟「App 中断 handler」的 High 订阅，然后从真实 stdin 喂 `\x1b`。
 * 测的是生产代码本身，不是复刻一份逻辑。
 *
 * ⚠️ 必须包 `KeypressProvider`：`useKeypress` 无 provider 会 throw，React 会把整帧吞成 "\n"。
 */

import { describe, test, expect } from "bun:test";
import React, { useState } from "react";
import { PassThrough } from "node:stream";
import { renderSync } from "@sid-code/cli/ui/render-port/testing.ts";
import { Text } from "@sid-code/cli/ui/render-port/components.ts";
import {
  KeypressProvider,
  KeypressPriority,
  useKeypress,
  ESC_TIMEOUT,
  type Key,
} from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import { useRewindEscape } from "@sid-code/cli/ui/hooks/use-rewind-escape.ts";

/** 门控状态：测试里可随时改，改完 `setGate` 会强制重渲让 hook 拿到新闭包。 */
interface GateState {
  busy: boolean;
  panelOpen: boolean;
  wired: boolean;
  inputEmpty: boolean;
  /** 补全菜单是否打开（模拟 InputArea 的 Normal 优先级消费）。 */
  completionOpen: boolean;
}

function mountHarness(initial: Partial<GateState> = {}) {
  const opened: string[] = [];
  const hints: string[] = [];
  const interrupts: string[] = [];
  const completionClosed: string[] = [];

  const gate: GateState = {
    busy: false,
    panelOpen: false,
    wired: true,
    inputEmpty: true,
    completionOpen: false,
    ...initial,
  };
  let rerender: () => void = () => {};

  function Probe() {
    const [, force] = useState(0);
    rerender = () => force((n) => n + 1);

    // 模拟 App 的中断 handler（High 优先级）：忙时消费 Esc。
    // 这一段不是被测对象，是**前置条件下的竞争者**——用来验证「被上层消费掉的 Esc 不计入双击」。
    useKeypress(KeypressPriority.High, (key: Key) => {
      if (key.name !== "escape") return false;
      if (!gate.busy) return false;
      interrupts.push(key.name);
      return true;
    });

    // 模拟 InputArea 的补全分支（Normal 优先级）：补全打开时消费 Esc。
    // 这是「被上层/同层先消费掉的 Esc 不计入双击」的第二个验证点——
    // 如果回退判定被提到 High，它就会抢在 Normal 前面弹面板（变异自证覆盖）。
    useKeypress(KeypressPriority.Normal, (key: Key) => {
      if (key.name !== "escape") return false;
      if (!gate.completionOpen) return false;
      completionClosed.push(key.name);
      return true;
    });

    useRewindEscape({
      gate: { busy: gate.busy, panelOpen: gate.panelOpen, wired: gate.wired },
      // 生产侧也是函数形式（读 ref 取最新值），这里读可变对象同理。
      isInputEmpty: () => gate.inputEmpty,
      onOpen: () => opened.push("open"),
      onFirstPress: () => hints.push("hint"),
    });

    return <Text>probe</Text>;
  }

  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number;
    rows: number;
  };
  stdout.columns = 80;
  stdout.rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = false;
  stdout.on("data", () => {});

  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const stdinAny = stdin as unknown as Record<string, unknown>;
  stdinAny.isTTY = true;
  stdinAny.setRawMode = () => stdin;
  stdinAny.setEncoding = () => stdin;
  stdinAny.ref = () => stdin;
  stdinAny.unref = () => stdin;

  const instance = renderSync(
    <KeypressProvider>
      <Probe />
    </KeypressProvider>,
    { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
  );

  return {
    opened,
    hints,
    interrupts,
    completionClosed,
    /** 改门控并重渲（hook 的 canOpen 闭包依赖这些字段）。 */
    setGate: (patch: Partial<GateState>) => {
      Object.assign(gate, patch);
      rerender();
    },
    /**
     * 送一次按键后等 `waitMs`。
     * 默认等 2×ESC_TIMEOUT：单个 `\x1b` 要在解析器里等满 ESC_TIMEOUT 才会被冲刷成 `escape`，
     * 不等就发下一个字节会被合成为 `escape-escape`（那是另一条路径，不是人手双击）。
     */
    press: async (seq: string, waitMs = ESC_TIMEOUT * 2) => {
      stdin.emit("data", seq);
      await new Promise((r) => setTimeout(r, waitMs));
    },
    unmount: () => instance.unmount(),
  };
}

describe("Esc 双击打开会话回退（接线）", () => {
  test("空闲 + 输入框为空：间隔约 100ms 连按两次 Esc ⇒ 打开回退面板", async () => {
    const h = mountHarness({ inputEmpty: true });
    await h.press("\x1b");
    await h.press("\x1b");
    expect(h.opened).toEqual(["open"]);
    // 第一击应当给一次引导（渐进衰减由 App 侧计数，这里只锁"提示过一次"）。
    expect(h.hints).toEqual(["hint"]);
    h.unmount();
  });

  test("间隔超过窗口（1000ms）⇒ 不打开（两次都是第一击）", async () => {
    const h = mountHarness({ inputEmpty: true });
    await h.press("\x1b", 1000);
    await h.press("\x1b");
    expect(h.opened).toEqual([]);
    expect(h.hints).toEqual(["hint", "hint"]);
    h.unmount();
  });

  test("忙时第一次 Esc 被中断 handler 消费 ⇒ 紧接着再按一次不打开面板", async () => {
    const h = mountHarness({ inputEmpty: true, busy: true });
    // 第一次：High 的中断 handler 先消费，到不了 Low，不计入双击。
    await h.press("\x1b");
    expect(h.interrupts).toHaveLength(1);
    expect(h.opened).toEqual([]);

    // 中断完成，恢复空闲；紧接着的第二次 Esc 只能算「第一击」。
    h.setGate({ busy: false });
    await h.press("\x1b");
    expect(h.opened).toEqual([]);
    h.unmount();
  });

  test("输入框非空 ⇒ 双击不打开（也不清空输入）", async () => {
    const h = mountHarness({ inputEmpty: false });
    await h.press("\x1b");
    await h.press("\x1b");
    expect(h.opened).toEqual([]);
    expect(h.hints).toEqual([]);
    h.unmount();
  });

  test("Esc · 打字 · Esc ⇒ 不算双击（非 Esc 按键复位计时）", async () => {
    const h = mountHarness({ inputEmpty: true });
    await h.press("\x1b");
    await h.press("a", 0); // 打字（这里没有 InputArea 消费，验证的是观察者复位）
    await h.press("\x1b");
    expect(h.opened).toEqual([]);
    h.unmount();
  });

  test("快路径：同一次 data 的 \x1b\x1b ⇒ 打开（与慢路径同口径）", async () => {
    const h = mountHarness({ inputEmpty: true });
    await h.press("\x1b\x1b");
    expect(h.opened).toEqual(["open"]);
    h.unmount();
  });

  test("快路径同样受输入框非空门控（两条路径口径一致）", async () => {
    const h = mountHarness({ inputEmpty: false });
    await h.press("\x1b\x1b");
    expect(h.opened).toEqual([]);
    h.unmount();
  });

  test("补全菜单打开时：第一次 Esc 关补全（不计入双击），第二次不打开面板", async () => {
    const h = mountHarness({ inputEmpty: true, completionOpen: true });
    await h.press("\x1b");
    expect(h.completionClosed).toHaveLength(1);
    expect(h.opened).toEqual([]);

    // 补全已关，紧接着的第二次 Esc 只能算「第一击」。
    h.setGate({ completionOpen: false });
    await h.press("\x1b");
    expect(h.opened).toEqual([]);
    h.unmount();
  });

  test("有面板打开时不响应双击（不抢面板的 Esc）", async () => {
    const h = mountHarness({ inputEmpty: true, panelOpen: true });
    await h.press("\x1b");
    await h.press("\x1b");
    expect(h.opened).toEqual([]);
    h.unmount();
  });

  test("回退能力未接线（headless / bridge 无回调）时不打开空面板", async () => {
    const h = mountHarness({ inputEmpty: true, wired: false });
    await h.press("\x1b");
    await h.press("\x1b");
    expect(h.opened).toEqual([]);
    h.unmount();
  });
});
