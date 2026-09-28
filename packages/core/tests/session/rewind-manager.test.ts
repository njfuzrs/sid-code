/**
 * RewindManager 测试（P2-1 会话回退核心逻辑）
 *
 * 用假 ctxMgr/checkpoint 依赖驱动，覆盖：登记点、仅对话回退、对话+代码回退、
 * 回退后清理未来点、环形上限、无快照时代码回退跳过。
 */

import { describe, test, expect } from "bun:test";
import {
  RewindManager,
  MAX_REWIND_POINTS,
  type RewindDeps,
} from "@sid-code/core/session/rewind-manager.ts";

/**
 * 构造一个内存 ctxMgr + checkpoint 假依赖。
 *
 * N6：注入项里**没有** getLatestSnapshotId 了。文件锚点的来源从「登记时取最新快照」
 * 改成「本轮首个快照建成时由 attachSnapshot() 回填」，所以本文件用例的写法也随之变成
 * `registerPoint(...)` 之后调 `mgr.attachSnapshot("sN")` —— 这与生产时序一致
 * （registerPoint 在用户输入提交前，快照在本轮工具执行前才建）。
 */
function makeDeps(initialMsgs: unknown[] = []) {
  let messages = [...initialMsgs];
  const restoreCalls: string[] = [];
  const deps: RewindDeps = {
    getMessages: () => messages,
    setMessages: (m) => {
      messages = [...m];
    },
    restoreToSnapshot: async (id) => {
      restoreCalls.push(id);
      return 2; // 假装回滚了 2 个文件
    },
  };
  return {
    deps,
    restoreCalls,
    get messages() {
      return messages;
    },
    pushMsg: (m: unknown) => {
      messages.push(m);
    },
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

  // ───────────────────────────────────────────────────────────
  // N6：文件锚点必须是「本轮首个快照」，不是「登记时刻的最新快照」
  //
  // registerPoint 跑在用户输入提交**前**，本轮快照那时还不存在。旧实现在这里取
  // getLatestSnapshotId()，拿到的是**上一轮**建的快照 ⇒ 按「快照 sN = 改动前」的口径，
  // 回滚到 s_{N-1} 会退到轮 N-1 那次调用之前，比用户要的「轮 N 之前」多撤一整轮；
  // 回退到第 1 轮时锚点更是恒为空串 ⇒ 文件层永不回滚（最想撤的那次恰恰撤不掉）。
  // ───────────────────────────────────────────────────────────
  describe("N6：回退点文件锚点的来源", () => {
    test("登记时锚点为空，由本轮首个快照回填", () => {
      const h = makeDeps();
      const mgr = new RewindManager(h.deps);
      const p = mgr.registerPoint("轮1", 1000);
      // 登记瞬间本轮还没建快照 —— 这里绝不能是上一轮的 id。
      expect(p.snapshotId).toBe("");

      mgr.attachSnapshot("s1");
      expect(mgr.getPoint(p.id)!.snapshotId).toBe("s1");
    });

    test("一轮内多次工具调用：只认首个快照（幂等）", async () => {
      const h = makeDeps();
      const mgr = new RewindManager(h.deps);
      const p1 = mgr.registerPoint("轮1", 1000);
      // 本轮连续三次工具调用 ⇒ 三个快照。「回到本轮之前」要回滚到**首个**，
      // 因为只有它记录的才是本轮任何改动发生前的状态。
      mgr.attachSnapshot("s1");
      mgr.attachSnapshot("s2");
      mgr.attachSnapshot("s3");
      expect(mgr.getPoint(p1.id)!.snapshotId).toBe("s1");

      await mgr.rewindTo(p1.id, "code", 2000);
      expect(h.restoreCalls).toEqual(["s1"]);
    });

    test("第 1 轮也有文件锚点（旧实现此处恒为空 ⇒ 永不回滚）", async () => {
      const h = makeDeps();
      const mgr = new RewindManager(h.deps);
      const p1 = mgr.registerPoint("第一轮", 1000);
      mgr.attachSnapshot("s1");
      h.pushMsg("u1");

      const res = await mgr.rewindTo(p1.id, "conversation-and-code", 2000);
      expect(res!.fileRestoreSkipped).toBe(false);
      expect(h.restoreCalls).toEqual(["s1"]);
    });

    test("回退到第 2 轮不会撤掉第 1 轮的改动（不再多退一轮）", async () => {
      const h = makeDeps();
      const mgr = new RewindManager(h.deps);
      mgr.registerPoint("轮1", 1000);
      mgr.attachSnapshot("s1"); // 轮1 的改动
      h.pushMsg("u1");
      h.pushMsg("a1");
      const p2 = mgr.registerPoint("轮2", 2000);
      mgr.attachSnapshot("s2"); // 轮2 的改动
      h.pushMsg("u2");
      h.pushMsg("a2");

      await mgr.rewindTo(p2.id, "conversation-and-code", 3000);
      // 必须回滚到 s2（轮2 改动前）。旧实现会回滚到 s1 ⇒ 轮1 的正确改动一起没了。
      expect(h.restoreCalls).toEqual(["s2"]);
    });

    test("本轮没建过快照 ⇒ 锚点留空，退化为仅回退对话（不误用别轮快照）", async () => {
      const h = makeDeps();
      const mgr = new RewindManager(h.deps);
      mgr.registerPoint("轮1", 1000);
      mgr.attachSnapshot("s1");
      h.pushMsg("u1");
      // 轮2 是纯问答，没有任何文件改动 ⇒ 不该借用轮1 的快照。
      const p2 = mgr.registerPoint("轮2", 2000);
      h.pushMsg("u2");

      const res = await mgr.rewindTo(p2.id, "conversation-and-code", 3000);
      expect(res!.fileRestoreSkipped).toBe(true);
      expect(h.restoreCalls).toEqual([]);
    });

    test("attachSnapshot 对空 id / 无回退点时安全无操作", () => {
      const h = makeDeps();
      const mgr = new RewindManager(h.deps);
      // 还没有任何回退点（非交互入口）——不该抛错。
      mgr.attachSnapshot("s1");
      expect(mgr.hasPoints()).toBe(false);

      const p = mgr.registerPoint("轮1", 1000);
      // checkpoint 未启用时 createSnapshot 返回空串，不该把锚点写成空串以外的东西。
      mgr.attachSnapshot("");
      expect(mgr.getPoint(p.id)!.snapshotId).toBe("");
    });
  });

  test("仅对话回退：截断到锚点，丢弃其后消息", async () => {
    const h = makeDeps();
    const mgr = new RewindManager(h.deps);
    // 轮1：登记点（index 0），追加 user+assistant。
    const p1 = mgr.registerPoint("轮1", 1000);
    h.pushMsg("u1");
    h.pushMsg("a1");
    // 轮2：登记点（index 2），追加 user+assistant。
    mgr.registerPoint("轮2", 2000);
    h.pushMsg("u2");
    h.pushMsg("a2");
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
    const p1 = mgr.registerPoint("轮1", 1000);
    // N6：本轮快照在登记之后才建成，由 attachSnapshot 回填为本轮锚点。
    mgr.attachSnapshot("s5");
    h.pushMsg("u1");
    h.pushMsg("a1");

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
    h.pushMsg("u1");
    h.pushMsg("a1");
    mgr.registerPoint("轮2", 2000);
    h.pushMsg("u2");
    h.pushMsg("a2");
    expect(mgr.listPoints().length).toBe(2);

    await mgr.rewindTo(p1.id, "conversation", 3000);
    // 轮1 及其后（轮2）都应被清理。
    expect(mgr.hasPoints()).toBe(false);
  });

  test("listPoints 最新在前", () => {
    const h = makeDeps();
    const mgr = new RewindManager(h.deps);
    mgr.registerPoint("A", 1000);
    h.pushMsg("x");
    mgr.registerPoint("B", 2000);
    h.pushMsg("y");
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

/**
 * mode=code（仅代码）：对齐 CC Esc+Esc 菜单的第三档——只回滚文件，**保留对话**。
 * 用途：用户想留着上下文直接重试，只撤销模型改坏的文件，不必把提问重说一遍。
 */
describe("RewindManager mode=code（仅代码）", () => {
  test("只回滚文件，对话完全不动", async () => {
    const h = makeDeps();
    const mgr = new RewindManager(h.deps);
    const p1 = mgr.registerPoint("轮1", 1000);
    // N6：轮1 的锚点 = 轮1 自己建的首个快照（登记之后才建成）。
    mgr.attachSnapshot("s7");
    h.pushMsg("u1");
    h.pushMsg("a1");
    mgr.registerPoint("轮2", 2000);
    mgr.attachSnapshot("s8");
    h.pushMsg("u2");
    h.pushMsg("a2");

    const res = await mgr.rewindTo(p1.id, "code", 3000);
    expect(res).not.toBeNull();
    expect(res!.mode).toBe("code");
    expect(res!.filesRestored).toBe(2);
    expect(res!.fileRestoreSkipped).toBe(false);
    expect(h.restoreCalls).toEqual(["s7"]);
    // 关键：对话一条都没丢
    expect(res!.messagesDropped).toBe(0);
    expect(h.messages).toEqual(["u1", "a1", "u2", "a2"]);
  });

  test("回退点全部保留（对话未变，未来点仍可用）", async () => {
    const h = makeDeps();
    const mgr = new RewindManager(h.deps);
    const p1 = mgr.registerPoint("轮1", 1000);
    mgr.attachSnapshot("s1");
    h.pushMsg("u1");
    mgr.registerPoint("轮2", 2000);
    mgr.attachSnapshot("s2");
    h.pushMsg("u2");
    expect(mgr.listPoints().length).toBe(2);

    await mgr.rewindTo(p1.id, "code", 3000);
    // 与 conversation 模式不同：这里不清理任何点
    expect(mgr.listPoints().length).toBe(2);
  });

  test("无快照时跳过回滚且不动对话", async () => {
    const h = makeDeps();
    const mgr = new RewindManager(h.deps);
    // latestSnapshot 保持空串
    const p1 = mgr.registerPoint("轮1", 1000);
    h.pushMsg("u1");

    const res = await mgr.rewindTo(p1.id, "code", 2000);
    expect(res!.fileRestoreSkipped).toBe(true);
    expect(res!.filesRestored).toBe(0);
    expect(res!.messagesDropped).toBe(0);
    expect(h.restoreCalls).toEqual([]);
    expect(h.messages).toEqual(["u1"]);
  });

  test("三档模式互不干扰：code 后仍可再做 conversation 回退", async () => {
    const h = makeDeps();
    const mgr = new RewindManager(h.deps);
    const p1 = mgr.registerPoint("轮1", 1000);
    mgr.attachSnapshot("s3");
    h.pushMsg("u1");
    h.pushMsg("a1");

    await mgr.rewindTo(p1.id, "code", 2000);
    expect(h.messages.length).toBe(2);

    const res2 = await mgr.rewindTo(p1.id, "conversation", 3000);
    expect(res2!.messagesDropped).toBe(2);
    expect(h.messages).toEqual([]);
  });
});
