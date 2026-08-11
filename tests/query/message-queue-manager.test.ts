/**
 * 缺口1 Phase A：统一优先级消息队列内核 —— 确定性单测
 *
 * 覆盖验收标准 1：三优先级出队顺序（now>next>later、同级 FIFO）确定性验证。
 * 另覆盖：drainByPriority 分级 drain、peek/hasPending 探测、快照稳定引用、clear/reset。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  enqueueCommand,
  drainByPriority,
  drainByKind,
  drainByPriorityAndKind,
  dequeueFirstByKind,
  peek,
  hasPending,
  queueSize,
  getQueueSnapshot,
  subscribeQueue,
  clearQueue,
  __resetForTest,
  type CommandKind,
} from "@sid-code/core/query/message-queue-manager.ts";

function enq(priority: "now" | "next" | "later", payload: string, kind: CommandKind = "user-input") {
  return enqueueCommand({ priority, kind, payload });
}

describe("message-queue-manager（Phase A 内核）", () => {
  beforeEach(() => __resetForTest());
  // 队列是模块级单例：本文件跑完必须清空，否则残留命令会漏进后续测试文件的 queryLoop
  //（dequeuePendingNotifications 会注入这些残留，用测试假 payload 触发下游崩溃）。
  afterEach(() => __resetForTest());

  test("出队顺序：now → next → later", () => {
    // 乱序入队
    enq("later", "L1");
    enq("now", "N1");
    enq("next", "M1");
    const drained = drainByPriority("later").map((c) => c.payload);
    expect(drained).toEqual(["N1", "M1", "L1"]);
  });

  test("同优先级严格 FIFO（按入队序号，不用墙钟）", () => {
    enq("next", "A");
    enq("next", "B");
    enq("next", "C");
    const drained = drainByPriority("later").map((c) => c.payload);
    expect(drained).toEqual(["A", "B", "C"]);
  });

  test("混合优先级 + 同级 FIFO 组合确定性", () => {
    enq("next", "u1");
    enq("later", "n1");
    enq("now", "esc1");
    enq("next", "u2");
    enq("now", "esc2");
    enq("later", "n2");
    // now: esc1, esc2（FIFO）→ next: u1, u2 → later: n1, n2
    const drained = drainByPriority("later").map((c) => c.payload);
    expect(drained).toEqual(["esc1", "esc2", "u1", "u2", "n1", "n2"]);
  });

  test("drainByPriority('now') 只取 now 级，next/later 留在队列", () => {
    enq("now", "esc1");
    enq("next", "u1");
    enq("later", "n1");
    const nowOnly = drainByPriority("now").map((c) => c.payload);
    expect(nowOnly).toEqual(["esc1"]);
    // 剩余 next + later 仍在
    expect(queueSize()).toBe(2);
    const rest = drainByPriority("later").map((c) => c.payload);
    expect(rest).toEqual(["u1", "n1"]);
  });

  test("drainByPriority('next') 取 now+next，later 保留", () => {
    enq("later", "n1");
    enq("now", "esc1");
    enq("next", "u1");
    const drained = drainByPriority("next").map((c) => c.payload);
    expect(drained).toEqual(["esc1", "u1"]);
    expect(queueSize()).toBe(1);
    expect(peek()?.payload).toBe("n1");
  });

  test("空队列 drain 返回空数组", () => {
    expect(drainByPriority("later")).toEqual([]);
    expect(drainByPriority("now")).toEqual([]);
  });

  test("peek 不出队；hasPending 分级探测", () => {
    enq("later", "n1");
    expect(hasPending("now")).toBe(false); // 只有 later，无 now
    expect(hasPending("later")).toBe(true);
    enq("now", "esc1");
    expect(hasPending("now")).toBe(true);
    expect(peek()?.payload).toBe("esc1"); // now 级排最前
    expect(queueSize()).toBe(2); // peek 不出队
  });

  test("id 唯一且单调递增", () => {
    const a = enq("next", "A");
    const b = enq("next", "B");
    expect(a.id).not.toBe(b.id);
    expect(a.enqueuedAt).toBeLessThan(b.enqueuedAt);
  });

  test("快照稳定引用：队列不变时 getQueueSnapshot 返回同一引用", () => {
    enq("next", "A");
    const s1 = getQueueSnapshot();
    const s2 = getQueueSnapshot();
    expect(s1).toBe(s2); // 同引用（useSyncExternalStore 要求）
    enq("next", "B");
    const s3 = getQueueSnapshot();
    expect(s3).not.toBe(s1); // 变更后新引用
    expect(s3.length).toBe(2);
  });

  test("subscribe 在入队/出队/清空时收到通知", () => {
    let count = 0;
    const unsub = subscribeQueue(() => count++);
    enq("next", "A"); // +1
    enq("now", "B"); // +1
    drainByPriority("now"); // +1
    clearQueue(); // +1（队列仍有 A）
    expect(count).toBe(4);
    unsub();
    enq("next", "C"); // 取消订阅后不再通知
    expect(count).toBe(4);
  });

  test("clearQueue 清空但不重置 seq（id 跨清空仍唯一）", () => {
    const a = enq("next", "A");
    clearQueue();
    expect(queueSize()).toBe(0);
    const b = enq("next", "B");
    expect(b.id).not.toBe(a.id); // seq 未回退
    expect(b.enqueuedAt).toBeGreaterThan(a.enqueuedAt);
  });

  test("clearQueue 空队列不触发通知（幂等）", () => {
    let count = 0;
    subscribeQueue(() => count++);
    clearQueue(); // 队列本就空
    expect(count).toBe(0);
  });

  test("kind 字段透传，供消费方区分注入方式", () => {
    enq("later", "notif-payload", "task-notification");
    enq("next", "user-text", "user-input");
    const drained = drainByPriority("later");
    expect(drained[0].kind).toBe("user-input"); // next 先于 later
    expect(drained[1].kind).toBe("task-notification");
  });

  test("drainByKind 只取指定 kind，其余原位保留且顺序不变", () => {
    enq("next", "u1", "user-input");
    enq("later", "n1", "task-notification");
    enq("next", "u2", "user-input");
    enq("later", "n2", "task-notification");
    const notifs = drainByKind("task-notification").map((c) => c.payload);
    expect(notifs).toEqual(["n1", "n2"]); // 保持 FIFO
    // user-input 未被误吞，顺序不变
    const users = drainByKind("user-input").map((c) => c.payload);
    expect(users).toEqual(["u1", "u2"]);
    expect(queueSize()).toBe(0);
  });

  test("drainByKind 无匹配返回空数组，不动队列", () => {
    enq("next", "u1", "user-input");
    expect(drainByKind("task-notification")).toEqual([]);
    expect(queueSize()).toBe(1); // user-input 仍在
  });

  test("dequeueFirstByKind 只取队首匹配项，保持其余顺序", () => {
    enq("next", "u1", "user-input");
    enq("later", "n1", "task-notification");
    enq("next", "u2", "user-input");
    const first = dequeueFirstByKind("user-input");
    expect(first?.payload).toBe("u1");
    expect(queueSize()).toBe(2);
    // 再取一次拿到 u2（n1 不受影响）
    const second = dequeueFirstByKind("user-input");
    expect(second?.payload).toBe("u2");
    expect(peek()?.payload).toBe("n1"); // 只剩通知
  });

  test("dequeueFirstByKind 无匹配返回 undefined", () => {
    enq("later", "n1", "task-notification");
    expect(dequeueFirstByKind("user-input")).toBeUndefined();
    expect(queueSize()).toBe(1);
  });

  test("now 级抢占优先于同 kind 的 next（drainByKind 仍按优先级序）", () => {
    enq("next", "u1", "user-input");
    enq("now", "esc1", "user-input"); // ESC 改向
    const users = drainByKind("user-input").map((c) => c.payload);
    expect(users).toEqual(["esc1", "u1"]); // now 排最前
  });

  describe("drainByPriorityAndKind（priority + kind 双条件）", () => {
    test("只取 now 级 user-input，其余 kind / 优先级全保留", () => {
      enq("now", "esc1", "user-input"); // ✓ 取
      enq("now", "perm1", "permission-response"); // kind 不匹配 → 留
      enq("next", "u2", "user-input"); // 优先级不够 → 留
      const taken = drainByPriorityAndKind("now", "user-input").map((c) => c.payload);
      expect(taken).toEqual(["esc1"]);
      // 剩余 2 条顺序不变
      const rest = getQueueSnapshot().map((c) => c.payload);
      expect(rest).toEqual(["perm1", "u2"]);
    });

    test("多条 now 级 user-input 保持 FIFO", () => {
      enq("now", "a", "user-input");
      enq("now", "b", "user-input");
      enq("now", "c", "user-input");
      const taken = drainByPriorityAndKind("now", "user-input").map((c) => c.payload);
      expect(taken).toEqual(["a", "b", "c"]);
      expect(queueSize()).toBe(0);
    });

    test("无匹配返回空数组、不触发通知", () => {
      let notified = 0;
      const unsub = subscribeQueue(() => notified++);
      enq("later", "n1", "task-notification");
      notified = 0; // 忽略入队通知
      const taken = drainByPriorityAndKind("now", "user-input");
      expect(taken).toEqual([]);
      expect(notified).toBe(0); // 无变更不 emit
      expect(queueSize()).toBe(1);
      unsub();
    });
  });
});
