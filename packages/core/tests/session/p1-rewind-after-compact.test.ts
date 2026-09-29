/**
 * N7 门禁：压缩之后 Rewind 的对话锚点失效，不能静默空转、更不能清空回退点。
 *
 * 修之前：messageIndex 是数组下标，压缩把 40 条换成 8 条后 `slice(0, 40)` 原样返回全部，
 * messagesDropped=0（UI 显示「丢弃 0 条」），随后按「已丢弃未来」把回退点全部过滤掉。
 */

import { describe, test, expect } from "bun:test";
import { RewindManager } from "@sid-code/core/session/rewind-manager.ts";

function setup(initial: number) {
  let msgs: unknown[] = Array.from({ length: initial }, (_, i) => ({ i }));
  const restored: string[] = [];
  const mgr = new RewindManager({
    getMessages: () => msgs,
    setMessages: (m) => {
      msgs = m;
    },
    restoreToSnapshot: async (id) => {
      restored.push(id);
      return 1;
    },
  });
  return {
    mgr,
    restored,
    get msgs() {
      return msgs;
    },
    set msgs(v: unknown[]) {
      msgs = v;
    },
  };
}

describe("N7：压缩后回退点的对话锚点", () => {
  test("压缩后回退对话 ⇒ 明确失败；对话、文件、回退点全部原样", async () => {
    const env = setup(40);
    const p = env.mgr.registerPoint("第 N 轮", 1);
    env.mgr.attachSnapshot("s5");
    env.msgs = [...env.msgs, { i: 40 }, { i: 41 }];
    // 压缩：42 条 → 8 条，并通知管理器。
    env.msgs = Array.from({ length: 8 }, (_, i) => ({ c: i }));
    env.mgr.onMessagesCompacted();

    const before = env.msgs;
    const r = await env.mgr.rewindTo(p.id, "conversation-and-code", 2);
    expect(r).not.toBeNull();
    expect(r!.conversationUnavailable).toBe(true);
    expect(r!.messagesDropped).toBe(0);
    expect(env.msgs).toBe(before); // 未写回
    expect(env.restored).toEqual([]); // 不做半截（只回文件不回对话）
    expect(env.mgr.hasPoints()).toBe(true); // 修之前这里会被清空
    expect(env.mgr.getPoint(p.id)).not.toBeNull();
  });

  test("压缩后仍可做「仅代码」回退（文件锚点是快照 id，与消息数组无关）", async () => {
    const env = setup(10);
    const p = env.mgr.registerPoint("x", 1);
    env.mgr.attachSnapshot("s3");
    env.mgr.onMessagesCompacted();
    const r = await env.mgr.rewindTo(p.id, "code", 2);
    expect(r!.conversationUnavailable).toBeUndefined();
    expect(r!.filesRestored).toBe(1);
    expect(env.restored).toEqual(["s3"]);
  });

  test("压缩之后新登记的点不受影响，可以正常截断", async () => {
    const env = setup(40);
    env.mgr.registerPoint("旧", 1);
    env.msgs = Array.from({ length: 8 }, (_, i) => ({ c: i }));
    env.mgr.onMessagesCompacted();
    const fresh = env.mgr.registerPoint("新", 2);
    env.msgs = [...env.msgs, { u: 1 }, { a: 1 }];
    const r = await env.mgr.rewindTo(fresh.id, "conversation", 3);
    expect(r!.conversationUnavailable).toBeUndefined();
    expect(r!.messagesDropped).toBe(2);
    expect(env.msgs.length).toBe(8);
    // 旧点（messageIndex=40 ≥ 8）因截断清理规则被移除，新点本身也被移除——与未压缩时的语义一致。
    expect(env.mgr.hasPoints()).toBe(false);
  });

  test("兜底：未收到压缩通知但下标越界 ⇒ 同样判失败，不静默空转", async () => {
    const env = setup(40);
    const p = env.mgr.registerPoint("x", 1);
    env.msgs = Array.from({ length: 8 }, (_, i) => ({ c: i })); // 某条路径改写了数组却没通知
    const r = await env.mgr.rewindTo(p.id, "conversation", 2);
    expect(r!.conversationUnavailable).toBe(true);
    expect(env.mgr.hasPoints()).toBe(true);
  });

  test("未压缩时行为不变：截断并清理该点及之后的点", async () => {
    const env = setup(4);
    const p1 = env.mgr.registerPoint("1", 1);
    env.msgs = [...env.msgs, { u: 1 }, { a: 1 }];
    env.mgr.registerPoint("2", 2);
    env.msgs = [...env.msgs, { u: 2 }];
    const r = await env.mgr.rewindTo(p1.id, "conversation", 3);
    expect(r!.conversationUnavailable).toBeUndefined();
    expect(r!.messagesDropped).toBe(3);
    expect(env.msgs.length).toBe(4);
    expect(env.mgr.hasPoints()).toBe(false);
  });
});
