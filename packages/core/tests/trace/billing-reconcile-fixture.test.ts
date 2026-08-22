/**
 * 对账 fixture —— 方案 §6 判据 2 与判据 5
 *
 * ## 为什么必须**两个**会话（这条是方案明写的要求，不是我加的谨慎）
 *
 * 单一 fixture 无法区分「修对了」与「针对那一个会话调参调对了」。所以这里收了
 * 两个**跨模型**的真实会话：`deepseek-v4-pro`（官方直连）与 `deepseek-v4-flash`。
 * 两者的漏采率不同（56% vs 54%）、幽灵流数不同（22 vs 7），一个只对其中一个成立的
 * "修复"会在另一个上露出来。
 *
 * ## fixture 是**修复前**的轨迹快照，这是刻意的
 *
 * `streamPhasesWithAgentId: 0` / `maxAttempt: 8` 都是**病态**数据 —— 它们记录的是
 * 缺陷长什么样。用途有两个：
 *   ① 让「事故的事实基线」可复算，而不是只活在一份 markdown 里；
 *   ② 给判据 5 一个**已知会红**的输入（见下方那条测试）——
 *      一个从来没见过病态输入的唯一性断言，无法证明它真的能拦住病态。
 *
 * ⚠️ 所以**不要**"顺手把 fixture 更新成修复后的样子"。它一旦变成健康数据，
 * 这个文件就只能证明"健康数据是健康的"，那是同义反复。
 * 修复后的行为由 `billing-sink-structural.test.ts`（判据 6）与
 * `billing-identity-invariant.test.ts`（判据 1/§5.4）覆盖。
 *
 * 数据来源：`~/.sid-code/trajectories/sessions/{id}/events.jsonl` + `metadata.json`，
 * 由 fixture 生成时逐项核对过方案 §1.2 / §9.1 的数字（39/17/22、13/6/7、$0.2234、
 * flash 记账 cache_read 392,320）—— **全部对得上**。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface SessionFacts {
  model: string;
  httpConnected: number;
  afterModelRaw: number;
  ghostStreams: number;
  billedCacheRead: number;
  billedInputTokens: number;
  streamPhaseCount: number;
  streamPhasesWithAgentId: number;
  maxAttempt: number;
  busiestIndex: number;
  busiestIndexPhases: number;
  reportedCostUSD: number;
}

const FIXTURE: Record<string, SessionFacts> = JSON.parse(
  readFileSync(join(import.meta.dir, "../fixtures/billing/ghost-stream-sessions.json"), "utf-8"),
);

const PRO = "20260821-140626-4fd1f34e";
const FLASH = "20260821-115135-bcfeb51e";

describe("判据 2：对账 fixture（至少两个会话，跨模型）", () => {
  test("fixture 确实有两个会话且模型不同（单 fixture 分不清'修对了'与'调参调对了'）", () => {
    const ids = Object.keys(FIXTURE);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const models = new Set(ids.map((i) => FIXTURE[i].model));
    expect(models.size).toBeGreaterThanOrEqual(2);
  });

  test("pro 会话：事故基线 39 建连 / 17 记账 / 22 幽灵流（§1.2 逐项核对过）", () => {
    const f = FIXTURE[PRO];
    expect(f.model).toBe("deepseek-v4-pro");
    expect(f.httpConnected).toBe(39);
    expect(f.afterModelRaw).toBe(17);
    expect(f.ghostStreams).toBe(22);
    // 漏采率 56% —— 方案 §9.1 表里那个最严重的一行
    expect(f.ghostStreams / f.httpConnected).toBeCloseTo(0.564, 2);
  });

  test("flash 会话：13 / 6 / 7，漏采率 54%（独立第二个证据）", () => {
    const f = FIXTURE[FLASH];
    expect(f.model).toBe("deepseek-v4-flash");
    expect(f.httpConnected).toBe(13);
    expect(f.afterModelRaw).toBe(6);
    expect(f.ghostStreams).toBe(7);
    expect(f.ghostStreams / f.httpConnected).toBeCloseTo(0.538, 2);
    // 方案 §9.1 引用的那个数：记账侧 cache_read 392,320
    expect(f.billedCacheRead).toBe(392_320);
  });

  test("两个会话的漏采率都 ≥25%：这不是偶发抖动，是每 4 个请求漏 1 个", () => {
    for (const id of [PRO, FLASH]) {
      const f = FIXTURE[id];
      expect(f.ghostStreams / f.httpConnected).toBeGreaterThanOrEqual(0.25);
    }
  });

  test("自报成本 $0.2234 —— 与账单 ¥7.23 差 4.56 倍那个数的分子", () => {
    // 这条锚住"事故当时我们自己以为花了多少"。修复改的是**将来**的计价，
    // 不会改写这份历史快照 —— 所以它是个稳定的锚点。
    expect(FIXTURE[PRO].reportedCostUSD).toBeCloseTo(0.2234, 4);
    // 账单反推：¥7.23 / 7.1 ≈ $1.018，与 $0.2234 之比 ≈ 4.56
    const billUSD = 7.23 / 7.1;
    expect(billUSD / FIXTURE[PRO].reportedCostUSD).toBeCloseTo(4.56, 1);
  });
});

describe("判据 5：单 index 下的 attempt 唯一性（幽灵流与主循环共用计数器）", () => {
  /**
   * 判据 5 的实现：给定一组 (index, attempt, agentId) 三元组，
   * 同一把键上出现两条 `completed` 即失衡。
   *
   * 之所以在测试里写这个判定而不是引生产函数：判据 5 检查的是**轨迹数据的性质**，
   * 消费者是离线分析（`scripts/trace-digest.ts` 那一类），不是运行时热路径。
   * 生产侧对应的防线是 `request-context.ts` 让身份进 key（见下面第二条测试）。
   */
  function duplicateCompletedKeys(
    phases: Array<{ index: number; attempt: number; agentId?: string; phase: string }>,
  ): string[] {
    const seen = new Map<string, number>();
    for (const p of phases) {
      if (p.phase !== "completed") continue;
      const key = `${p.agentId ?? "main"}#${p.index}#${p.attempt}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  }

  test("门禁自证：不带身份时，两条链共用 index 会撞键（事故的真实形态）", () => {
    // fixture 记录了这个形态：pro 会话 195 个 StreamPhase 里 **0 个**带 agent_id，
    // 且最忙的 index 17 上挤了 40 个 phase、attempt 一路涨到 8。
    expect(FIXTURE[PRO].streamPhasesWithAgentId).toBe(0);
    expect(FIXTURE[PRO].maxAttempt).toBe(8);
    expect(FIXTURE[PRO].busiestIndex).toBe(17);
    expect(FIXTURE[PRO].busiestIndexPhases).toBeGreaterThan(30);

    // 同样的形态喂给判定：主循环与 fork 都没有身份 → 撞键
    const dups = duplicateCompletedKeys([
      { index: 17, attempt: 1, phase: "completed" }, // 主循环
      { index: 17, attempt: 1, phase: "completed" }, // fork，被贴上主循环的 index
    ]);
    expect(dups).toEqual(["main#17#1"]);
  });

  test("带上 agentId（PR2 的 ALS 身份）之后，同一 index 不再撞键", () => {
    const dups = duplicateCompletedKeys([
      { index: 17, attempt: 1, phase: "completed" },
      { index: 17, attempt: 1, agentId: "fork:session-memory-update", phase: "completed" },
      { index: 17, attempt: 1, agentId: "fork:memory-extract", phase: "completed" },
    ]);
    expect(dups).toEqual([]);
  });

  test("真·重试（同链同 index、attempt 递增）不被误判成撞键", () => {
    // 这条防的是"为了让判据 5 变绿而把重试也一起判成异常"。
    const dups = duplicateCompletedKeys([
      { index: 3, attempt: 1, phase: "completed" },
      { index: 3, attempt: 2, phase: "completed" },
      { index: 3, attempt: 3, phase: "completed" },
    ]);
    expect(dups).toEqual([]);
  });

  test("非 completed 的 phase 不参与判定（fetch_sent 每次重试都会有一条）", () => {
    const dups = duplicateCompletedKeys([
      { index: 3, attempt: 1, phase: "fetch_sent" },
      { index: 3, attempt: 1, phase: "first_content" },
      { index: 3, attempt: 1, phase: "completed" },
    ]);
    expect(dups).toEqual([]);
  });
});
