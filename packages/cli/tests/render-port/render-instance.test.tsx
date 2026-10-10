/**
 * 契约 X7 / R13（B9 / T0.5 遗留）：端口的实例能力面与测试环境的出帧方式。
 *
 * X7：CI 没有 `tsc`，`RenderInstance` 接口本身拦不住漂移 —— 新底座少实现一个方法，
 * CLI 那行 `?.forceRedraw()` 会静默变成 no-op（可选链吞掉 undefined）。所以这里在运行时
 * 逐个核对，并反查接口与方法清单一致。
 *
 * R13：测试环境同步出帧是全仓几千个 `lastFrame()` 断言的前提，`enableFrameThrottle()`
 * 必须能打开真实调度、并在恢复后回到同步。
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Text } from "@sid-code/cli/ui/render-port/components.ts";
import {
  getRenderInstance,
  RENDER_INSTANCE_METHODS,
} from "@sid-code/cli/ui/render-port/runtime.ts";
import { enableFrameThrottle } from "@sid-code/cli/ui/render-port/testing.ts";
import { mountTTY, tick, ttyStreams } from "./tty-streams.ts";

const RUNTIME_SRC = join(import.meta.dir, "../../src/ui/render-port/runtime.ts"); // 接口定义在切换层，不在 legacy/

describe("X7 实例能力面", () => {
  test("X7: 挂载后 getRenderInstance 返回的实例上，清单里每个方法都是函数", () => {
    const s = ttyStreams({ stdoutTTY: false });
    const m = mountTTY(<Text>x</Text>, s);
    const inst = getRenderInstance(s.stdout) as unknown as Record<string, unknown>;
    expect(inst).toBeDefined();
    const missing = RENDER_INSTANCE_METHODS.filter((k) => typeof inst[k] !== "function");
    m.teardown();
    expect(missing).toEqual([]);
  });

  test("X7: 未挂载 / 卸载后返回 undefined", () => {
    const s = ttyStreams({ stdoutTTY: false });
    expect(getRenderInstance(s.stdout)).toBeUndefined();
    const m = mountTTY(<Text>x</Text>, s);
    m.inst.unmount();
    expect(getRenderInstance(s.stdout)).toBeUndefined();
  });

  test("X7: RenderInstance 接口的方法与 RENDER_INSTANCE_METHODS 一一对应", () => {
    const src = readFileSync(RUNTIME_SRC, "utf8");
    const body = /export interface RenderInstance \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
    const declared = [...body.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]).sort();
    expect(declared.length).toBeGreaterThan(0);
    expect(declared).toEqual([...RENDER_INSTANCE_METHODS].sort());
  });
});

describe("R13 测试环境出帧方式", () => {
  async function framesAfterBurst() {
    const s = ttyStreams();
    let frames = 0;
    const m = mountTTY(<Text>n=0</Text>, s, { onFrame: () => frames++ });
    await tick();
    const base = frames;
    for (let i = 1; i <= 5; i++) m.inst.rerender(<Text>n={i}</Text>);
    const sync = frames - base;
    await tick(50);
    const total = frames - base;
    m.teardown();
    return { sync, total };
  }

  test("R13: 默认每次提交同步出帧（5 次 rerender 立即 5 帧）", async () => {
    expect(await framesAfterBurst()).toEqual({ sync: 5, total: 5 });
  });

  test("R13: enableFrameThrottle 打开后合并成 2 帧，恢复后回到同步", async () => {
    const restore = enableFrameThrottle();
    let throttled;
    try {
      throttled = await framesAfterBurst();
    } finally {
      restore();
    }
    expect(throttled).toEqual({ sync: 0, total: 2 });
    expect(await framesAfterBurst()).toEqual({ sync: 5, total: 5 });
  });
});
