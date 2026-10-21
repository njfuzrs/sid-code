/**
 * 发现 3 / 4 / 14 回归（20261020-110542-ce7ea52e 会话评估）
 *
 * - 发现 4a：masking 轮的 usage 是「遮罩后发送量」，校准分母却是「遮罩前全量」——不同源 →
 *   因子被压低 → 下一轮跌回 none → 发出全量 → 又被拉回 soft，隔轮翻转（实测 15 个翻转点）。
 * - 发现 4b：遮罩只活在发送副本里，level 一退就恢复原文，已发送前缀来回改写。
 * - 发现 4c：遮罩释放量不进 tokenFreedTracker，P0-5 扣减对它无效。
 * - 发现 3b：管线目标线等于 hard 触发点，压完仍停在 masking 区边缘。
 * - 发现 14：ContextManager 自己改写前缀时要能报出来源。
 *
 * 断言对着「评估报告里的复现形态」写：循环「发送 → 用发送副本的真实 usage 校准 → 判档」，
 * 修复前 level 交替、修复后稳定在 soft，被遮罩的 id 集合单调不减。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "@sid-code/core/context/manager.ts";
import { pipelineTargetRatioFrom } from "@sid-code/core/query/compact/index.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

// masking 会把被遮罩的原文落到会话临时目录；重定向到 tmpdir，不碰真实路径。
let tmpRoot = "";
const savedTmp = process.env.SID_CODE_TMPDIR;
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sid-masking-cal-"));
  process.env.SID_CODE_TMPDIR = tmpRoot;
});
afterAll(() => {
  if (savedTmp === undefined) delete process.env.SID_CODE_TMPDIR;
  else process.env.SID_CODE_TMPDIR = savedTmp;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const WINDOW = 1_000_000;

/** n 轮 read 工具调用，每条结果 chars 个字符（远超 masking 50K 保护窗口与 30K 批量阈值） */
function history(rounds: number, chars: number): Message[] {
  const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "开始" }] }];
  for (let i = 0; i < rounds; i++) {
    msgs.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t${i}`, name: "bash", input: { command: `cat f${i}` } }],
    });
    msgs.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `t${i}`, content: `行${i}\n`.repeat(chars / 4) },
      ],
    });
  }
  msgs.push({ role: "assistant", content: [{ type: "text", text: "继续" }] });
  msgs.push({ role: "user", content: [{ type: "text", text: "下一步" }] });
  return msgs;
}

function maskedIds(sent: Message[]): Set<string> {
  const ids = new Set<string>();
  for (const m of sent)
    for (const b of m.content)
      if (b.type === "tool_result" && b.content.startsWith("[tool_output_masked]"))
        ids.add(b.tool_use_id);
  return ids;
}

/** 模拟服务端：真实 usage = 发送副本按「真实比例」计的 token（这里取 raw 估算 × 1.0） */
function fakeUsage(mgr: Manager, sent: Message[]): number {
  return mgr.estimateTokensFor(sent, 0);
}

/** 把历史调到刚过 soft 线（78%）、未到 hard 线（82%）的位置 */
function managerNearSoftLine(): Manager {
  const mgr = new Manager({ maxTokens: WINDOW });
  mgr.setSessionId("masking-cal-test");
  mgr.setSystemPrompt("sys");
  // 二分找一个落在 soft 区的轮数（估算器细节变化时测试仍能自我定位）
  for (let rounds = 40; rounds < 400; rounds++) {
    mgr.setMessages(history(rounds, 32_000));
    if (mgr.getCompactionLevel() === "soft") return mgr;
  }
  throw new Error("前提不成立：找不到落在 soft 区的历史长度");
}

describe("发现 4a/4b — masking 校准同源，不再隔轮翻转", () => {
  test("循环 10 轮：校准因子不被遮罩拉低，level 不交替，被遮罩的 id 集合单调不减", () => {
    const mgr = managerNearSoftLine();
    const levels: string[] = [];
    const factors: number[] = [];
    let prev = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const sent = mgr.getCleanedMessages();
      const ids = maskedIds(sent);
      // 4b：已遮罩的不得恢复原文
      for (const id of prev) expect(ids.has(id)).toBe(true);
      prev = ids;
      mgr.recordActualTokens(fakeUsage(mgr, sent), 0);
      factors.push((mgr as any).calibrationFactor as number);
      levels.push(mgr.getCompactionLevel());
    }
    // 前提：确实发生过遮罩（否则本测试空转）
    expect(prev.size).toBeGreaterThan(0);
    // 4a 根因：服务端真实比例恒为 1.0 ⇒ 同源校准下因子恒≈1。
    // 修复前分母是全量 raw，因子被压到「发送量/全量」（本形态约 0.6）。
    for (const f of factors) expect(f).toBeCloseTo(1, 2);
    // 修复前形态：soft,none,soft,none…（自激翻转）。修复后首轮之后档位不再变化。
    // 注：稳定在 none 而非 soft 是 4c 的预期——遮罩释放量已从 used 扣掉，
    // 实际发送量确实在 soft 线以下；粘滞保证已遮罩的条目不会因此恢复原文。
    expect(new Set(levels.slice(1)).size).toBe(1);
  });

  test("遮罩轮之后的锚点按全量口径换算，不被遮罩后的低 usage 钉低", () => {
    const mgr = managerNearSoftLine();
    const fullEstimate = mgr.estimateTokens(0);
    const sent = mgr.getCleanedMessages();
    const sentTokens = fakeUsage(mgr, sent);
    expect(sentTokens).toBeLessThan(fullEstimate); // 前提：确实遮罩了
    mgr.recordActualTokens(sentTokens, 0);
    // 全量估算不应跌到「遮罩后发送量」那一档
    expect(mgr.estimateTokens(0)).toBeGreaterThan(sentTokens);
    expect(mgr.getLastActualInputTokens()).toBeGreaterThan(sentTokens);
  });

  test("未遮罩时校准行为与旧口径一致（发送副本 = 全量）", () => {
    const mgr = new Manager({ maxTokens: WINDOW });
    mgr.setSystemPrompt("sys");
    mgr.setMessages(history(5, 2_000));
    const raw = mgr.estimateTokensFor(mgr.getMessages(), 0);
    mgr.getCleanedMessages();
    mgr.recordActualTokens(raw * 2, 0);
    // 首次校准直接取比值；发送副本与全量一致 ⇒ 因子≈2、锚点 = 真实值
    expect(mgr.getLastActualInputTokens()).toBe(raw * 2);
    expect(mgr.estimateTokensFor(mgr.getMessages(), 0)).toBeGreaterThanOrEqual(raw * 2 - 2);
  });

  test("4b：压缩/setMessages 统一清空遮罩粘滞状态", () => {
    const mgr = managerNearSoftLine();
    const sent = mgr.getCleanedMessages();
    expect(maskedIds(sent).size).toBeGreaterThan(0);
    // 整体替换为一份小历史：不得残留旧遮罩
    mgr.setMessages(history(3, 1_000));
    expect(maskedIds(mgr.getCleanedMessages()).size).toBe(0);
  });

  test("4b：遮罩占位字节级稳定（前缀不因重算漂移）", () => {
    const mgr = managerNearSoftLine();
    const first = mgr.getCleanedMessages();
    const second = mgr.getCleanedMessages();
    const pick = (ms: Message[]) =>
      ms.flatMap((m) =>
        m.content.filter(
          (b) => b.type === "tool_result" && b.content.startsWith("[tool_output_masked]"),
        ),
      );
    expect(JSON.stringify(pick(second))).toBe(JSON.stringify(pick(first)));
  });
});

describe("发现 4c — 遮罩释放量进 tokenFreedTracker，只记一次", () => {
  test("首次遮罩后 getCompactionLevel 的 used 被扣减；重复发送不重复扣", () => {
    const mgr = managerNearSoftLine();
    const freed = () => (mgr as any).tokenFreedTracker.getTotalFreed() as number;
    expect(freed()).toBe(0);
    mgr.getCleanedMessages();
    const once = freed();
    expect(once).toBeGreaterThan(0);
    mgr.getCleanedMessages();
    mgr.getCleanedMessages();
    expect(freed()).toBe(once);
  });
});

describe("发现 3b — 管线目标线落在 masking 线下方 5%", () => {
  test("1M 窗口压到目标线后 level 为 none（不再停在 masking 区边缘）", () => {
    const mgr = new Manager({ maxTokens: WINDOW });
    const target = pipelineTargetRatioFrom(mgr);
    const t = mgr.getCompactionThresholds();
    expect(target).toBeCloseTo((t.effectiveWindow - t.maskingRemaining) / WINDOW - 0.05, 5);
    // 用锚点把估算钉在目标线上，验证该处判档为 none
    mgr.setSystemPrompt("sys");
    mgr.setMessages([{ role: "user", content: [{ type: "text", text: "x" }] }]);
    mgr.recordActualTokens(Math.floor(target * WINDOW), 0);
    expect(mgr.getCompactionLevel()).toBe("none");
  });

  test("override 把 hard 线压到 masking 线以下时，目标不高于触发点", () => {
    const mgr = new Manager({ maxTokens: WINDOW });
    (mgr as any).autoCompactPctOverride = 0.5;
    const t = mgr.getCompactionThresholds();
    expect(pipelineTargetRatioFrom(mgr)).toBeLessThanOrEqual(t.compactionTriggerUsed / WINDOW);
  });

  test("小窗口（≤60K）没有 masking 档，目标线沿用触发点", () => {
    const mgr = new Manager({ maxTokens: 32_000 });
    const t = mgr.getCompactionThresholds();
    expect(pipelineTargetRatioFrom(mgr)).toBeCloseTo(
      Math.min(0.95, Math.max(0.3, t.compactionTriggerUsed / 32_000)),
      5,
    );
  });
});

describe("发现 14 — 本地改写发送前缀的来源可被取走", () => {
  test("首次遮罩报 masking；之后粘滞发送不再重复报；整体替换报 compact", () => {
    const mgr = managerNearSoftLine();
    mgr.consumeSendMutationCauses(); // 丢掉 setMessages 带来的 compact
    mgr.getCleanedMessages();
    expect(mgr.consumeSendMutationCauses()).toContain("masking");
    mgr.getCleanedMessages();
    expect(mgr.consumeSendMutationCauses()).not.toContain("masking");
    mgr.setMessages(history(3, 1_000));
    expect(mgr.consumeSendMutationCauses()).toEqual(["compact"]);
    expect(mgr.consumeSendMutationCauses()).toEqual([]);
  });
});
