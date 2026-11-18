/**
 * 展示口径必须与压缩决策同源：扣掉「本地已释放量」。
 *
 * 事故形态（2026-11-09）：同一份 `estimateTokens`，两个消费者两套算法——
 * `getCompactionLevel()` 减了 `tokenFreedTracker.getTotalFreed()`，
 * 而 `getContextUsageForDisplay()`（Footer / 状态栏）和 `getTokenBreakdown()`（/context）
 * 一分不扣。tokenFreedTracker 记的正是「发送副本已经瘦掉、全量历史里还在」的部分：
 * 大输出清理（cleanedMessages）、冷缓存清理（coldCacheClear）、遮罩（masking）。
 *
 * 后果不是差几个点：长会话实测展示值虚高 1.9–2.7 倍（三个会话分别
 * 1,162,927→438,012、1,163,778→364,057、1,599,574→830,237），而且数字永不回落。
 *
 * 断言对着两个可观察后果写：
 *  1. 清理后展示值必须跟着降（旧行为恒定不变）；
 *  2. 展示值必须精确等于 `max(0, estimateTokens − freed)`——与决策同一表达式，
 *     不是「大概小一点」。
 */

import { describe, test, expect } from "bun:test";
import { Manager } from "@sid-code/core/context/manager.ts";
import { estimateConversationTokens } from "@sid-code/core/context/token.ts";
import { TOKEN_THRESHOLDS } from "@sid-code/core/context/auto-compact.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

/** n 轮 read 调用，每条结果 chars 字符。
 *  > microcompact 的 500 字符阈值（才进冷清理候选），< 大输出 30K 阈值（走独立路径）。 */
function history(rounds: number, chars = 2_000): Message[] {
  const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "开始" }] }];
  for (let i = 0; i < rounds; i++) {
    msgs.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t${i}`, name: "read", input: { file_path: `f${i}.ts` } }],
    });
    msgs.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `${i}`.repeat(chars) }],
    });
  }
  return msgs;
}

/** 造一个「有东西可清」的 manager，返回清理释放量（与 tokenFreedTracker 同口径）。 */
function managerWithFreedTokens(): { mgr: Manager; freed: number } {
  const mgr = new Manager({ maxTokens: 1_000_000 });
  mgr.setMessages(history(10));
  mgr.consumeSendMutationCauses();
  const r = mgr.applyColdCacheClear();
  expect(r.cleared).toBeGreaterThan(0); // 前提：确实发生了清理，否则下面的断言无意义
  // A3（2026-11-18）：记账口径统一为 `estimateTextTokens(原文) − estimateTextTokens(占位)`，
  // `Math.ceil(savedChars / 4)` 已从四处删除。这里不再自己按字符数推一遍——那正是
  // 「测试复刻了实现的一个错误假设」的形态，实现改了它不会跟着改。
  // 直接取 getter（语义 = 决策里实际减掉的那个量），断言才真的在验「同源」。
  return { mgr, freed: mgr.getLocalFreedTokens() };
}

describe("getContextUsageForDisplay 扣掉本地已释放量（与 getCompactionLevel 同源）", () => {
  test("本地清理后展示占用必须下降（旧行为：恒定不变，永远按膨胀历史计价）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(10));

    const before = mgr.getContextUsageForDisplay();
    const r = mgr.applyColdCacheClear();
    expect(r.cleared).toBeGreaterThan(0);
    const after = mgr.getContextUsageForDisplay();

    expect(after.used).toBeLessThan(before.used);
    // 百分比同源派生，必须跟着降（否则 Footer 与 used 两个口径自相矛盾）
    expect(after.percentOfWindow).toBeLessThanOrEqual(before.percentOfWindow);
  });

  test("used 精确等于 max(0, estimateTokens − freed)：与决策是同一个表达式，不是「大概小一点」", () => {
    const { mgr, freed } = managerWithFreedTokens();

    const u = mgr.getContextUsageForDisplay();

    // estimateTokens 只读全量历史，清理不动它 —— 差额只能来自 freed
    expect(freed).toBeGreaterThan(0);
    expect(u.used).toBe(Math.max(0, mgr.estimateTokens() - freed));
  });

  test("未发生本地清理时展示值不变（不凭空造减量）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages([{ role: "user", content: [{ type: "text", text: "只有一条消息" }] }]);

    const before = mgr.getContextUsageForDisplay();
    expect(mgr.applyColdCacheClear().cleared).toBe(0); // 无可清
    const after = mgr.getContextUsageForDisplay();

    expect(after.used).toBe(before.used);
    expect(after.used).toBe(mgr.estimateTokens());
  });
});

describe("getTokenBreakdown 扣掉本地已释放量（/context 与 Footer 不能两套数）", () => {
  test("清理后 total 下降，且下降量与实际释放量一致", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(10));

    const beforeTotal = mgr.getTokenBreakdown().total;
    const beforeUsed = mgr.getContextUsageForDisplay().used;
    mgr.applyColdCacheClear();
    const afterTotal = mgr.getTokenBreakdown().total;
    const afterUsed = mgr.getContextUsageForDisplay().used;

    expect(afterTotal).toBeLessThan(beforeTotal);
    // 两个展示出口的减量必须相等 —— 这正是「同源」的可观测形式
    expect(beforeTotal - afterTotal).toBe(beforeUsed - afterUsed);
  });

  test("释放量单列在 freed 字段，不再从 toolResult 分类里扣（PR1 口径）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(10));
    mgr.applyColdCacheClear();

    const b = mgr.getTokenBreakdown();
    expect(b.freed.tokens).toBeGreaterThan(0);
    // PR1：分类是「扣减前」的规模，freed 单列成字段，不从任何分类里减。
    // 旧实现从 toolResult 里扣，代价是「分类之和 ≠ 毛估算」——UI 只能给一个混算后的数，
    // 用户看不见「谁释放的、释放了多少」，也没法核对账目。
    expect(b.categories.reduce((sum, c) => sum + c.tokens, 0)).toBe(b.grossTokens);
    // 未校准时锚点为 0，total 与分类合计的差恰好是本地释放量
    expect(b.total).toBe(b.grossTokens - b.freed.tokens);
    expect(b.categories.every((c) => c.tokens >= 0)).toBe(true);
  });

  test("校准时恒等式仍成立：total = 毛估算 + 锚点抬升 − 本地释放（钳零）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(10));
    // 喂一次真实 usage 让 calibrationFactor 生效，覆盖「先校准后扣减」这条路径
    mgr.recordActualTokens(50_000, 10);
    mgr.applyColdCacheClear();

    const b = mgr.getTokenBreakdown();
    expect(b.calibrated).toBe(true);
    expect(b.categories.reduce((sum, c) => sum + c.tokens, 0)).toBe(b.grossTokens);
    expect(b.total).toBe(Math.max(0, b.grossTokens + b.anchorLiftTokens - b.freed.tokens));
    expect(b.categories.every((c) => c.tokens >= 0)).toBe(true);
  });
});

/**
 * 混合夹具：既有走冷清理的中等输出（> microcompact 的 500 字符阈值），
 * 也有走大输出清理的大输出（> OUTPUT_THRESHOLD 30K 字符，且超过 KEEP_RECENT_OUTPUTS=6）。
 *
 * 两种清理的单位必须一致，否则 `tracker 累计 === raw(全量) − raw(发送副本)` 会有残差。
 */
function mixedHistory(): Message[] {
  const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "开始" }] }];
  // 8 个大输出（> 30K）：前 2 个超出 KEEP_RECENT_OUTPUTS 会被大输出清理
  for (let i = 0; i < 8; i++) {
    msgs.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `big${i}`, name: "bash", input: { command: `cmd${i}` } }],
    });
    msgs.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `big${i}`, content: `x`.repeat(35_000) }],
    });
  }
  // 6 个中等输出（2K）：冷清理候选（>500 字符）
  for (let i = 0; i < 6; i++) {
    msgs.push({
      role: "assistant",
      content: [
        { type: "tool_use", id: `mid${i}`, name: "read", input: { file_path: `f${i}.ts` } },
      ],
    });
    msgs.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `mid${i}`, content: `${i}`.repeat(2_000) }],
    });
  }
  return msgs;
}

describe("A3：记账与发送副本投影严格相等（4 个记账点同一单位）", () => {
  test("冷清理 + 大输出清理后，tracker 累计 === raw(全量) − raw(发送副本)", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(mixedHistory());
    mgr.consumeSendMutationCauses();

    // 依次走冷清理 → 发送副本（内部还有过期清理 → 大输出清理 → 旧引用折叠）
    const cold = mgr.applyColdCacheClear();
    expect(cold.cleared).toBeGreaterThan(0);
    const sent = mgr.getCleanedMessages();
    const full = mgr.getMessages();

    const rawFull = estimateConversationTokens(full, { toolCount: 0 });
    const rawSent = estimateConversationTokens(sent, { toolCount: 0 });

    // 前提：确实瘦了，否则下面的等式在 0=0 上空洞成立
    expect(rawFull).toBeGreaterThan(rawSent);
    // **严格相等**，不是「大概一致」。任何一处漏记 / 重复记都会让这条红。
    expect(mgr.getLocalFreedTokens()).toBe(rawFull - rawSent);
  });

  test("中文夹具同样严格相等（chars/4 在中文上偏差最大，必须单独覆盖）", () => {
    // 验收表 §8.1 A3 要求「中文、英文两套夹具」。这不是锦上添花：中文 1 字符 ≈ 1 token，
    // `Math.ceil(chars / 4)` 只记到 25% 左右；而占位文案本身是中文，两个方向都会错。
    // 只用 ASCII 夹具的话，旧口径的偏差恰好被 4 倍关系掩盖掉一大半。
    const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "开始" }] }];
    for (let i = 0; i < 8; i++) {
      msgs.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `big${i}`, name: "bash", input: { command: `c${i}` } }],
      });
      msgs.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `big${i}`, content: "中".repeat(35_000) }],
      });
    }
    for (let i = 0; i < 6; i++) {
      msgs.push({
        role: "assistant",
        content: [
          { type: "tool_use", id: `mid${i}`, name: "read", input: { file_path: `文档${i}.md` } },
        ],
      });
      msgs.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `mid${i}`, content: "说明".repeat(1_000) }],
      });
    }
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(msgs);
    mgr.consumeSendMutationCauses();

    const cold = mgr.applyColdCacheClear();
    expect(cold.cleared).toBeGreaterThan(0);
    const sent = mgr.getCleanedMessages();

    const rawFull = estimateConversationTokens(mgr.getMessages(), { toolCount: 0 });
    const rawSent = estimateConversationTokens(sent, { toolCount: 0 });
    expect(rawFull).toBeGreaterThan(rawSent);
    expect(mgr.getLocalFreedTokens()).toBe(rawFull - rawSent);

    // 首次校准同样要在中文夹具上成立（freed 已乘 factor）
    const X = 20_000;
    mgr.recordActualTokens(X, 0);
    expect(Math.abs(mgr.getSendTokens() - X)).toBeLessThanOrEqual(2);
  });

  test("重复调 getCleanedMessages 不重复记账（同一批块只记一次）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(mixedHistory());
    mgr.consumeSendMutationCauses();
    mgr.applyColdCacheClear();
    mgr.getCleanedMessages();

    const freedOnce = mgr.getLocalFreedTokens();
    // 第二次、第三次：发送副本内容不变 → 减量不得再涨
    mgr.getCleanedMessages();
    mgr.getCleanedMessages();
    expect(mgr.getLocalFreedTokens()).toBe(freedOnce);
  });

  test("旧持久化引用折叠也记账（第五个释放源，此前完全没记）", () => {
    // 引用约 200 字节：不会被冷清理（<500 字符）也不会被大输出清理（<30K），
    // 唯一会动它们的就是 collapseOldPersistedReferences —— 保留最近 20 个，更旧的折叠。
    //
    // ⚠️ 必须同时放几个真·大输出：getCleanedMessages 在 `cleanMap.size === 0` 时提前 return
    //（原文发出，折叠也跟着跳过），所以纯引用历史根本走不到折叠那段。
    // ⚠️ 且必须关掉过期清理通道：那 8 个大输出排在 25 轮引用之前，会被 stale 先清成占位，
    // 大输出清理随后看不到候选 → cleanMap 又空了 → 还是 early return。
    const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "开始" }] }];
    // 8 条 > 30K 的大输出，超过 KEEP_RECENT_OUTPUTS=6，保证 cleanMap 非空
    for (let i = 0; i < 8; i++) {
      msgs.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `big${i}`, name: "bash", input: { command: `c${i}` } }],
      });
      msgs.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `big${i}`, content: `x`.repeat(35_000) }],
      });
    }
    // 25 条持久化引用（> REFERENCE_KEEP_RECENT = 20，最早的 5 条会被折叠）
    for (let i = 0; i < 25; i++) {
      msgs.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `p${i}`, name: "bash", input: { command: `c${i}` } }],
      });
      msgs.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `p${i}`,
            content: `[持久化输出] 完整内容已保存到 /tmp/sess/out-${i}.jsonl（原始 100000 字符，超过内联阈值）`,
          },
        ],
      });
    }
    const mgr = new Manager({ maxTokens: 1_000_000, staleToolOutputClear: false });
    mgr.setMessages(msgs);
    mgr.consumeSendMutationCauses();

    const sent = mgr.getCleanedMessages();
    const full = mgr.getMessages();
    const rawFull = estimateConversationTokens(full, { toolCount: 0 });
    const rawSent = estimateConversationTokens(sent, { toolCount: 0 });

    // 前提：确实折叠了 —— 数一数发送副本里还剩几个完整引用
    const refsLeft = sent
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result" && typeof b.content === "string")
      .filter((b) => (b as { content: string }).content.startsWith("[持久化输出]")).length;
    expect(refsLeft).toBe(20);

    expect(rawFull).toBeGreaterThan(rawSent);
    // 不记账的话 getLocalFreedTokens() 会漏掉这 5 次折叠的减量，与右侧对不上
    expect(mgr.getLocalFreedTokens()).toBe(rawFull - rawSent);

    // 折叠每轮都从 `this.messages` 原文重算（结果不写回原文），同一个 id 会被反复折叠。
    // 没有粘滞集合就会重复记账、把减量算爆。
    const freedOnce = mgr.getLocalFreedTokens();
    mgr.getCleanedMessages();
    mgr.getCleanedMessages();
    expect(mgr.getLocalFreedTokens()).toBe(freedOnce);
  });

  test("首次校准：getSendTokens() 与真实输入 X 相差 ≤ 2（误差只来自 ceil/round）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(mixedHistory());
    mgr.consumeSendMutationCauses();
    mgr.applyColdCacheClear();
    const sent = mgr.getCleanedMessages();
    // 前提自证：发送副本确实比全量小（否则 factor 与 freed 都是 1/0，断言无意义）
    expect(estimateConversationTokens(sent, { toolCount: 0 })).toBeLessThan(
      estimateConversationTokens(mgr.getMessages(), { toolCount: 0 }),
    );

    // 首次校准：factor 恰好等于 X ÷ raw(发送副本)，校准估算与锚点几乎重合
    const X = 12_345;
    mgr.recordActualTokens(X, 0);
    expect(Math.abs(mgr.getSendTokens() - X)).toBeLessThanOrEqual(2);
  });

  test("EMA 之后 factor 高于本次比值：getSendTokens() >= X（锚点是下界，不是等式）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(mixedHistory());
    mgr.consumeSendMutationCauses();
    mgr.applyColdCacheClear();
    const sent = mgr.getCleanedMessages();
    const rawSent = estimateConversationTokens(sent, { toolCount: 0 });

    // 第一次喂一个远高于启发式的 usage → factor 被拉高
    mgr.recordActualTokens(rawSent * 4, 0);
    // 再喂一个正常量：EMA（α=0.3）后 factor 仍显著高于本次比值
    const X = rawSent; // 比值 ≈ 1，远低于当前 factor
    mgr.recordActualTokens(X, 0);

    // 这时 max 取的是「校准估算」那一支，只能断言下界语义。
    // 写成等于 X 等于要求 max 不起作用——那是把正确的行为断言成 bug。
    expect(mgr.getSendTokens()).toBeGreaterThanOrEqual(X);
  });
});

/**
 * A6 回归用例（§4.3.4）：本地释放量必须参与 blocking 判定。
 *
 * 缺陷形态：发送量已经瘦了 50K，但 blocking 仍按「未扣减的 197K」算剩余，
 * 于是 200K 窗口里 remaining = 3K ≤ TOKEN_THRESHOLDS.blocking，主循环误判
 * 「剩余极少、连一次 LLM 往返都危险」而强制截断——把本来还能正常跑的一轮砍掉。
 */
describe("A6 blocking 回归：200K 窗口 / 未扣减 197K / 已释放 50K", () => {
  test("getCompactionLevel 不是 hard/emergency，且主循环不判 blocking", () => {
    const WINDOW = 200_000;
    const mgr = new Manager({ maxTokens: WINDOW });
    // 填到「未扣减估算」逼近窗口：每条 8K 字符（约 4K token），40 条 ≈ 160K+
    const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "开始" }] }];
    for (let i = 0; i < 40; i++) {
      msgs.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `t${i}`, name: "bash", input: { command: `cmd${i}` } }],
      });
      msgs.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "中".repeat(8_000) }],
      });
    }
    mgr.setMessages(msgs);
    mgr.consumeSendMutationCauses();

    // 冷清理把这些块换成短占位 → 释放量足够大
    const cold = mgr.applyColdCacheClear();
    expect(cold.cleared).toBeGreaterThan(30);
    mgr.getCleanedMessages();

    const history = mgr.getHistoryTokens();
    const send = mgr.getSendTokens();
    const freed = mgr.getLocalFreedTokens();
    expect(freed).toBeGreaterThan(0);
    // 前提：未扣减口径确实逼近窗口（否则这条用例测不到那个误判）
    expect(history).toBeGreaterThan(WINDOW * 0.9);
    // 扣掉已释放量后，发送量应显著低于窗口
    expect(send).toBeLessThan(WINDOW * 0.9);
    expect(send).toBe(history - freed);

    // ① 压缩档位不是紧急档
    const level = mgr.getCompactionLevel();
    expect(["none", "soft"]).toContain(level);

    // ② 主循环的 blocking 判据（loop.ts：remainingTokens <= TOKEN_THRESHOLDS.blocking）
    const remainingTokens = WINDOW - send;
    expect(remainingTokens).toBeGreaterThan(TOKEN_THRESHOLDS.blocking);

    // ③ 反向自证：按未扣减口径算就会误判 —— 这正是改动前发生的事
    const remainingWithoutFree = WINDOW - history;
    expect(remainingWithoutFree).toBeLessThanOrEqual(TOKEN_THRESHOLDS.blocking);
  });
});
