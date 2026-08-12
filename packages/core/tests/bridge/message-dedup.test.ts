/**
 * BoundedUUIDSet 环形缓冲区去重单测（spec 16 §9.4）
 * 覆盖：容量边界、自动驱逐、O(1) 查询、重复 add 不占额外槽位
 */

import { describe, test, expect } from "bun:test";
import { BoundedUUIDSet } from "@sid-code/core/bridge/message-dedup.ts";

describe("BoundedUUIDSet", () => {
  test("基本 add/has", () => {
    const set = new BoundedUUIDSet(10);
    set.add("a");
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(false);
    expect(set.size).toBe(1);
  });

  test("重复 add 不增加 size、不占额外环形槽位", () => {
    const set = new BoundedUUIDSet(3);
    set.add("a");
    set.add("a");
    set.add("a");
    expect(set.size).toBe(1);
    // 由于重复未占槽位，再加 2 个不会驱逐 a
    set.add("b");
    set.add("c");
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(true);
  });

  test("超过容量时驱逐最旧条目（FIFO）", () => {
    const set = new BoundedUUIDSet(3);
    set.add("a");
    set.add("b");
    set.add("c");
    expect(set.size).toBe(3);

    set.add("d"); // 驱逐最旧的 a
    expect(set.has("a")).toBe(false);
    expect(set.has("d")).toBe(true);
    expect(set.size).toBe(3);

    set.add("e"); // 驱逐 b
    expect(set.has("b")).toBe(false);
    expect(set.has("c")).toBe(true);
    expect(set.has("e")).toBe(true);
  });

  test("容量为 1 时只保留最后一个", () => {
    const set = new BoundedUUIDSet(1);
    set.add("x");
    set.add("y");
    expect(set.has("x")).toBe(false);
    expect(set.has("y")).toBe(true);
    expect(set.size).toBe(1);
  });

  test("非法容量抛错", () => {
    expect(() => new BoundedUUIDSet(0)).toThrow();
    expect(() => new BoundedUUIDSet(-5)).toThrow();
  });

  test("大量插入 size 不超过容量（无内存泄漏）", () => {
    const set = new BoundedUUIDSet(100);
    for (let i = 0; i < 10_000; i++) {
      set.add(`id-${i}`);
    }
    expect(set.size).toBe(100);
    // 只保留最近 100 个
    expect(set.has("id-9999")).toBe(true);
    expect(set.has("id-9900")).toBe(true);
    expect(set.has("id-9899")).toBe(false);
  });
});
