/**
 * 假设登记表持久化与恢复测试（修复：`-c` 跨会话续做排查时交付门禁失据）
 *
 * 根因：HypothesisLedger.items/seq 是纯内存态，此前从未持久化也从未回灌 →
 * resume 后登记表全新为空，机制3「交付门禁」失去依据：上一会话登记的 open/refuted
 * 假设不再拦截交付，模型可能把未证实假设当结论写出去（正是本模块要防的 fdb47f30 事故）。
 *
 * 修复三段：
 *  1. HypothesisLedger.serialize() / hydrate()（本文件覆盖 round-trip + 脏快照容错）
 *  2. app.persistHypothesisLedger() 每轮 done 后 appendMetadata("hypothesis_ledger", …)
 *  3. app.restoreSession 读取 metadata["hypothesis_ledger"] 回灌
 * 这里覆盖 1（round-trip + 容错）+ 2 的落盘/读回（通过 SessionStore 端到端）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { HypothesisLedger } from "@sid-code/core/query/hypothesis-ledger.ts";
import { SessionStore } from "@sid-code/core/session/store.ts";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

/** 构造一个含若干假设的登记表（走真实 register/challenge 路径） */
function ledgerWithHypotheses(): HypothesisLedger {
  const l = new HypothesisLedger();
  l.register({
    statement: "进程崩溃导致任务中断",
    falsifier: "若日志显示 heartbeat 持续输出则说明进程存活未崩溃",
    turn: 1,
  });
  const h2 = l.register({
    statement: "配置文件未加载",
    falsifier: "若 config loaded 日志出现则配置已加载",
    turn: 2,
  });
  // 裁决 h2 为 refuted
  l.challenge({
    id: h2.id,
    verdict: "refute",
    evidence: { note: "日志确实出现 config loaded", source: "app.log:42", turn: 3 },
    turn: 3,
  });
  return l;
}

describe("假设登记表 serialize/hydrate round-trip", () => {
  test("登记 + 裁决若干假设后，snapshot 回灌到新实例，状态/证据完全一致", () => {
    const orig = ledgerWithHypotheses();
    const snap = orig.serialize();

    const restored = new HypothesisLedger();
    expect(restored.all()).toEqual([]); // 复现 bug 现象：恢复前为空

    restored.hydrate(snap);

    expect(restored.all().length).toBe(2);
    const origAll = orig.all();
    const restAll = restored.all();
    expect(restAll).toEqual(origAll);
    // 关键：refuted 状态与证据链跨恢复保留（交付门禁据此拦截）
    const refuted = restAll.find((h) => h.status === "refuted");
    expect(refuted).toBeDefined();
    expect(refuted!.refuting.length).toBe(1);
    expect(refuted!.refuting[0].note).toBe("日志确实出现 config loaded");
  });

  test("恢复后 seq 不回退，继续 register 不与已恢复假设撞号", () => {
    const orig = ledgerWithHypotheses(); // 生成 H1, H2
    const restored = new HypothesisLedger();
    restored.hydrate(orig.serialize());

    // 恢复后新登记应为 H3（不是 H1，避免覆盖已恢复假设）
    const h3 = restored.register({
      statement: "新假设",
      falsifier: "若出现 xyz 证据则推翻",
      turn: 10,
    });
    expect(h3.id).toBe("H3");
    expect(restored.all().length).toBe(3);
  });

  test("hasOpen 跨恢复保留（交付门禁提醒判定不失据）", () => {
    const orig = ledgerWithHypotheses(); // H1 open, H2 refuted
    expect(orig.hasOpen()).toBe(true);
    const restored = new HypothesisLedger();
    restored.hydrate(orig.serialize());
    expect(restored.hasOpen()).toBe(true);
  });

  test("serialize 返回深拷贝，改快照不污染内部状态", () => {
    const orig = ledgerWithHypotheses();
    const snap = orig.serialize();
    snap.items[0].status = "confirmed";
    snap.items[0].supporting.push({ note: "篡改" });
    snap.seq = 999;
    // 内部不受影响
    expect(orig.all()[0].status).toBe("open");
    expect(orig.all()[0].supporting.length).toBe(0);
  });
});

describe("hydrate 对脏/空快照容错，不抛错", () => {
  test("undefined / null / 非对象 / items 非数组 全部安全跳过", () => {
    const l = new HypothesisLedger();
    expect(() => l.hydrate(undefined)).not.toThrow();
    expect(() => l.hydrate(null)).not.toThrow();
    expect(() => l.hydrate("bad" as any)).not.toThrow();
    expect(() => l.hydrate({ items: "not-array" } as any)).not.toThrow();
    expect(l.all()).toEqual([]);
  });

  test("脏项被逐条过滤：缺 id/statement/falsifier、status 非法都跳过", () => {
    const l = new HypothesisLedger();
    l.hydrate({
      seq: 5,
      items: [
        { id: "H1", statement: "合法假设", falsifier: "若X则推翻", status: "open", falsifierCues: ["x"], supporting: [], refuting: [], createdTurn: 1, updatedTurn: 1, challengedFingerprints: [] }, // ✓
        { id: "H2", statement: "缺 falsifier", status: "open" }, // ✗
        { id: "H3", statement: "非法 status", falsifier: "x", status: "weird" }, // ✗
        { statement: "缺 id", falsifier: "x", status: "open" }, // ✗
        null, // ✗
        { id: "H4", falsifier: "缺 statement", status: "open" }, // ✗
      ],
    } as any);
    const all = l.all();
    expect(all.length).toBe(1);
    expect(all[0].id).toBe("H1");
  });

  test("seq 兜底：快照 seq 丢失时，从已恢复 id 编号推出 seq，续 register 不撞号", () => {
    const l = new HypothesisLedger();
    l.hydrate({
      // seq 缺失
      items: [
        { id: "H7", statement: "假设", falsifier: "若X则推翻", status: "open", falsifierCues: [], supporting: [], refuting: [], createdTurn: 1, updatedTurn: 1, challengedFingerprints: [] },
      ],
    } as any);
    // maxSeq 从 "H7" 推出 = 7，下一个应为 H8
    const next = l.register({ statement: "新", falsifier: "若Y则推翻" });
    expect(next.id).toBe("H8");
  });

  test("脏项数组回灌后覆盖为空（全脏时不污染）", () => {
    const l = ledgerWithHypotheses();
    expect(() => l.hydrate({ items: [{ bad: 1 }, "x", null] } as any)).not.toThrow();
    expect(l.all()).toEqual([]);
  });
});

describe("hypothesis_ledger metadata 落盘 + 读回（SessionStore 端到端）", () => {
  let testDir: string;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-code-hyp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code", "sessions"), { recursive: true });
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
  });

  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("serialize → appendMetadata → load 后可回灌，端到端等价", async () => {
    const ledger = ledgerWithHypotheses();

    const store = new SessionStore();
    store.startSession("hyp-e2e-001", "claude-opus-4-8", "anthropic", "/cwd");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "排查" }] });
    store.appendMetadata("hypothesis_ledger", ledger.serialize());
    SessionStore.flushPendingWrites();

    const loaded = await store.load("hyp-e2e-001");
    expect(loaded).not.toBeNull();
    expect(loaded!.metadata?.["hypothesis_ledger"]).toBeDefined();

    const resumed = new HypothesisLedger();
    resumed.hydrate(loaded!.metadata!["hypothesis_ledger"] as any);

    expect(resumed.all()).toEqual(ledger.all());
    expect(resumed.hasOpen()).toBe(true);
  });

  test("覆盖语义：多次落盘取最后一条（模拟每轮 done）", async () => {
    const store = new SessionStore();
    store.startSession("hyp-e2e-002", "claude-opus-4-8", "anthropic", "/cwd");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "排查" }] });

    // 第一轮：1 条 open
    const l1 = new HypothesisLedger();
    l1.register({ statement: "假设A", falsifier: "若X则推翻", turn: 1 });
    store.appendMetadata("hypothesis_ledger", l1.serialize());

    // 第二轮：A 被 confirmed
    const hA = l1.all()[0];
    l1.challenge({ id: hA.id, verdict: "confirm", evidence: { note: "证据支持A" }, turn: 2 });
    store.appendMetadata("hypothesis_ledger", l1.serialize());
    SessionStore.flushPendingWrites();

    const loaded = await store.load("hyp-e2e-002");
    const resumed = new HypothesisLedger();
    resumed.hydrate(loaded!.metadata!["hypothesis_ledger"] as any);

    expect(resumed.all()[0].status).toBe("confirmed");
    expect(resumed.hasOpen()).toBe(false);
  });

  test("空表快照落盘后恢复为空（/clear 后退出的边界：不复活旧假设）", async () => {
    const store = new SessionStore();
    store.startSession("hyp-e2e-003", "claude-opus-4-8", "anthropic", "/cwd");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "排查" }] });

    // clear 前：非空
    store.appendMetadata("hypothesis_ledger", ledgerWithHypotheses().serialize());
    // /clear 后：立即落空表快照
    store.appendMetadata("hypothesis_ledger", new HypothesisLedger().serialize());
    SessionStore.flushPendingWrites();

    const loaded = await store.load("hyp-e2e-003");
    const resumed = new HypothesisLedger();
    resumed.hydrate(loaded!.metadata!["hypothesis_ledger"] as any);

    expect(resumed.all()).toEqual([]);
  });
});
