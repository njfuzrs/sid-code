/**
 * RewindManager 测试（P2-1 会话回退核心逻辑）
 *
 * 用假 ctxMgr/checkpoint 依赖驱动，覆盖：登记点、仅对话回退、对话+代码回退、
 * 回退后清理未来点、环形上限、无快照时代码回退跳过。
 */

import { describe, test, expect } from "bun:test";
import { RewindManager, MAX_REWIND_POINTS, type RewindDeps } from "../../src/session/rewind-manager.ts";

/** 构造一个内存 ctxMgr + checkpoint 假依赖。 */
function makeDeps(initialMsgs: unknown[] = []) {
  let messages = [...initialMsgs];
  let latestSnapshot = "";
  const restoreCalls: string[] = [];
  const deps: RewindDeps = {
    getMessages: () => messages,
    setMessages: (m) => { messages = [...m]; },
    getLatestSnapshotId: () => latestSnapshot,
    restoreToSnapshot: async (id) => {
      restoreCalls.push(id);
      return 2; // 假装回滚了 2 个文件
    },
  };
  return {
    deps,
    restoreCalls,
    get messages() { return messages; },
    setLatestSnapshot: (id: string) => { latestSnapshot = id; },
    pushMsg: (m: unknown) => { messages.push(m); },
  };
}

describe("RewindManager", () => {
  test("registerPoint 记录当前消息下标为锚点", () => {
    const h = makeDeps(["m0", "m1"]);
    const mgr = new RewindManager(h.deps);
    const p = mgr.registerPoint("第一轮输入", 1000);
    expect(p.messageIndex).toBe(2); // 已有 2 条，本轮从下标 2 开始
    expect(p.inputPreview).toBe("第一轮输入");
    expect(p.id).toBe(1);
  });

  test("仅对话回退：截断到锚点，丢弃其后消息", async () => {
    const h = makeDeps();
    const mgr = new RewindManager(h.deps);
    // 轮1：登记点（index 0），追加 user+assistant。
    const p1 = mgr.registerPoint("轮1", 1000);
    h.pushMsg("u1"); h.pushMsg("a1");
    // 轮2：登记点（index 2），追加 user+assistant。
    mgr.registerPoint("轮2", 2000);
    h.pushMsg("u2"); h.pushMsg("a2");
    expect(h.messages.length).toBe(4);

    const res = await mgr.rewindTo(p1.id, "conversation", 3000);
    expect(res).not.toBeNull();
    expect(res!.messagesDropped).toBe(4); // 全丢（回到轮1之前）
    expect(h.messages).toEqual([]);
    expect(res!.filesRestored).toBe(0);
  });

  test("对话+代码回退：先 restore 快照再截断", async () => {
    const h = makeDeps();
    const mgr = new RewindManager(h.deps);
    h.setLatestSnapshot("s5");
    const p1 = mgr.registerPoint("轮1", 1000);
    h.pushMsg("u1"); h.pushMsg("a1");

    const res = await mgr.rewindTo(p1.id, "conversation-and-code", 2000);
    expect(res!.filesRestored).toBe(2);
    expect(res!.fileRestoreSkipped).toBe(false);
    expect(h.restoreCalls).toEqual(["s5"]);
    expect(h.messages).toEqual([]);
  });

  test("无快照时代码回退跳过（不报错）", async () => {
    const h = makeDeps();
    const mgr = new RewindManager(h.deps);
    // latestSnapshot 保持空串。
    const p1 = mgr.registerPoint("轮1", 1000);
    h.pushMsg("u1");
    const res = await mgr.rewindTo(p1.id, "conversation-and-code", 2000);
    expect(res!.fileRestoreSkipped).toBe(true);
    expect(res!.filesRestored).toBe(0);
    expect(h.restoreCalls).toEqual([]);
  });

  test("回退后清理落在锚点之后的点", async () => {
    const h = makeDeps();
    const mgr = new RewindManager(h.deps);
    const p1 = mgr.registerPoint("轮1", 1000);
    h.pushMsg("u1"); h.pushMsg("a1");
    mgr.registerPoint("轮2", 2000);
    h.pushMsg("u2"); h.pushMsg("a2");
    expect(mgr.listPoints().length).toBe(2);

    await mgr.rewindTo(p1.id, "conversation", 3000);
    // 轮1 及其后（轮2）都应被清理。
    expect(mgr.hasPoints()).toBe(false);
  });

  test("listPoints 最新在前", () => {
    const h = makeDeps();
    const mgr = new RewindManager(h.deps);
    mgr.registerPoint("A", 1000); h.pushMsg("x");
    mgr.registerPoint("B", 2000); h.pushMsg("y");
    const list = mgr.listPoints();
    expect(list[0].inputPreview).toBe("B");
    expect(list[1].inputPreview).toBe("A");
  });

  test("环形上限丢弃最旧点", () => {
    const h = makeDeps();
    const mgr = new RewindManager(h.deps);
    for (let i = 0; i < MAX_REWIND_POINTS + 5; i++) {
      mgr.registerPoint(`轮${i}`, 1000 + i);
      h.pushMsg(`m${i}`);
    }
    expect(mgr.listPoints().length).toBe(MAX_REWIND_POINTS);
  });

  test("长输入预览截断带省略号", () => {
    const h = makeDeps();
    const mgr = new RewindManager(h.deps);
    const long = "字".repeat(200);
    const p = mgr.registerPoint(long, 1000);
    expect(p.inputPreview.length).toBeLessThanOrEqual(60);
    expect(p.inputPreview.endsWith("…")).toBe(true);
  });

  test("clear 清空所有点", () => {
    const h = makeDeps();
    const mgr = new RewindManager(h.deps);
    mgr.registerPoint("x", 1000);
    mgr.clear();
    expect(mgr.hasPoints()).toBe(false);
    // clear 后 id 重置。
    const p = mgr.registerPoint("y", 2000);
    expect(p.id).toBe(1);
  });

  test("不存在的 id 回退返回 null", async () => {
    const h = makeDeps();
    const mgr = new RewindManager(h.deps);
    const res = await mgr.rewindTo(999, "conversation", 1000);
    expect(res).toBeNull();
  });
});
