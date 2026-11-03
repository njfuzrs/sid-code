/**
 * 瞬态消息必须到点自动消失（L4-H：短回执 4s、错误 8s）。
 *
 * 为什么锁这一层：`showTransientMessage` 曾经只 setState、没挂任何到期定时器，
 * 全仓也没有一处清空它的调用 —— 名字叫「瞬态」，行为却是永久驻留。
 * 2026-11-03 实测：粘贴一次触发「剪贴板无图片…」后，这行提示一直挂在输入框上方，
 * 只能靠退出进程才能去掉。
 *
 * 变异自证：
 * ① 把 UIStateProvider 里 showTransientMessage 的 setTimeout 去掉 → 「到点自动消失」红；
 * ② 去掉「新消息先作废旧定时器」→ 「新消息不被旧定时器清掉」红。
 */

import { describe, expect, test } from "bun:test";
import React, { useEffect } from "react";
import stripAnsi from "strip-ansi";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import {
  UIStateProvider,
  useUIActions,
  TransientMessageType,
} from "@sid-code/cli/ui/contexts/UIStateContext.tsx";
import { ToastDisplay } from "@sid-code/cli/ui/components/ToastDisplay.tsx";
import { Text } from "@sid-code/cli/ui/render-port/components.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 按行过滤后判断（L5.2：别全帧搜，其它区域可能含同样字符串）。
 * 这里帧里只有 toast + 底行，用行级判定仍然更明确。
 */
const hasLine = (frame: string, text: string) =>
  stripAnsi(frame)
    .split("\n")
    .some((line) => line.includes(text));

/** 挂载后发一条瞬态消息；ttlMs 注入短时长，避免测试等真实的 4s/8s。 */
function Seed({ text, ttlMs }: { text: string; ttlMs: number }) {
  const actions = useUIActions();
  useEffect(() => {
    actions.showTransientMessage(text, TransientMessageType.Warning, ttlMs);
  }, []);
  return null;
}

/** 先发一条短命消息，20ms 后再发一条长命消息（用于验证旧定时器被作废）。 */
function SeedOverlap() {
  const actions = useUIActions();
  useEffect(() => {
    actions.showTransientMessage("旧提示", TransientMessageType.Warning, 40);
    const timer = setTimeout(() => {
      actions.showTransientMessage("新提示", TransientMessageType.Warning, 400);
    }, 20);
    return () => clearTimeout(timer);
  }, []);
  return null;
}

/**
 * 恒定的底行：toast 消失后树不能变空。
 * 底座对「空树不写、不记帧」，只挂 toast 的话消息清空后 lastFrame() 会停在旧帧，
 * 断言「已消失」永远量的是那一帧 —— 这是 L5.2 记过的坑。
 */
const Baseline = () => <Text>底行-常驻</Text>;

const mounts = (children: React.ReactNode) =>
  render(
    <UIStateProvider>
      {children}
      <Baseline />
    </UIStateProvider>,
    { columns: 120, rows: 10 },
  );

describe("瞬态消息到点自动消失", () => {
  test("显示后到 TTL 即消失（不会永久挂在输入框上方）", async () => {
    const text = "提示-到点消失";
    const r = mounts(
      <>
        <Seed text={text} ttlMs={60} />
        <ToastDisplay />
      </>,
    );
    await sleep(30);
    expect(hasLine(r.lastFrame() ?? "", text)).toBe(true);
    await sleep(200);
    expect(hasLine(r.lastFrame() ?? "", text)).toBe(false);
    r.unmount();
  });

  test("新消息覆盖旧消息：旧定时器不会把新消息提前清掉", async () => {
    const r = mounts(
      <>
        <SeedOverlap />
        <ToastDisplay />
      </>,
    );
    // 旧消息 ttl=40ms、新消息在 20ms 发出。若 showTransientMessage 不作废旧定时器，
    // 新消息会在 40ms 处被旧定时器清掉 —— 下面这行就是那条断言的落点。
    await sleep(100);
    expect(stripAnsi(r.lastFrame() ?? "")).toContain("新提示");
    // 再等过新消息自己的 TTL，确认它同样会自动消失（不是靠"永不清除"通过上一条断言）。
    await sleep(420);
    expect(stripAnsi(r.lastFrame() ?? "")).not.toContain("新提示");
    r.unmount();
  });
});
