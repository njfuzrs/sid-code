/**
 * Phase 3 架构增强层单测
 * 覆盖：abort-controller（WeakRef 安全的父子取消层级）
 */

import { describe, test, expect } from "bun:test";
import { createChildAbortController } from "./abort-controller.ts";

describe("createChildAbortController", () => {
  test("父取消传播到子，携带 reason", () => {
    const parent = new AbortController();
    const child = createChildAbortController(parent.signal);

    expect(child.signal.aborted).toBe(false);
    parent.abort("parent-reason");
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe("parent-reason");
  });

  test("子主动取消不影响父", () => {
    const parent = new AbortController();
    const child = createChildAbortController(parent.signal);

    child.abort("child-reason");
    expect(child.signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  });

  test("快速路径：父已取消时，子立即取消", () => {
    const parent = new AbortController();
    parent.abort("already");
    const child = createChildAbortController(parent.signal);
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe("already");
  });

  test("无父信号：独立 controller", () => {
    const child = createChildAbortController();
    expect(child.signal.aborted).toBe(false);
    child.abort();
    expect(child.signal.aborted).toBe(true);
  });

  test("子完成后清理父监听器（无泄漏）", () => {
    const parent = new AbortController();

    // 记录父信号上的监听器数量变化
    let added = 0;
    let removed = 0;
    const origAdd = parent.signal.addEventListener.bind(parent.signal);
    const origRemove = parent.signal.removeEventListener.bind(parent.signal);
    parent.signal.addEventListener = ((...args: Parameters<typeof origAdd>) => {
      added++;
      return origAdd(...args);
    }) as typeof origAdd;
    parent.signal.removeEventListener = ((...args: Parameters<typeof origRemove>) => {
      removed++;
      return origRemove(...args);
    }) as typeof origRemove;

    const child = createChildAbortController(parent.signal);
    expect(added).toBe(1); // 注册了 1 个父监听器

    // 子先完成：abort 触发 dispose，移除父监听器
    child.abort();
    expect(removed).toBe(1); // 父监听器被清理
  });

  test("dispose 幂等，可重复调用", () => {
    const parent = new AbortController();
    const child = createChildAbortController(parent.signal);
    child.dispose();
    child.dispose(); // 不应抛错
    // 父取消后子不再被影响（监听器已移除）
    parent.abort();
    expect(child.signal.aborted).toBe(false);
  });
});
