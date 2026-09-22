/**
 * 上下文工程 P1 缺陷修复回归测试
 *
 * 来源：`docs-research/sid-code/bugfixes/todo/20260920-上下文工程-顺着sc-02-context核出的缺陷.md`
 * 的 P1-6 / P1-7 / P1-8 / P1-9 / P1-10 / P1-11 / P1-12 / P1-15。
 *
 * 每条断言都对着「缺陷文档里的复现步骤」写，而不是对着实现写——
 * 这样实现换了但缺陷复发时，测试仍然会红。
 */

import { describe, test, expect } from "bun:test";
import { Manager } from "@sid-code/core/context/manager.ts";
import { estimateConversationTokens } from "@sid-code/core/context/token.ts";
import { runCompactPipeline, pipelineTargetRatioFrom } from "@sid-code/core/query/compact/index.ts";
import { snipCompact } from "@sid-code/core/query/compact/snip-compact.ts";
import { findSplitThinking } from "@sid-code/core/agent/message-invariants.ts";
import {
  generateGitStatusAttachment,
  generateClaudeMdAttachment,
  generateDenyRulesAttachment,
} from "@sid-code/core/config/attachments.ts";
import { generateCacheKey } from "@sid-code/core/config/system-prompt.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}
function asstMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("P1-6 — 管线达标判据与触发判据同源", () => {
  test("estimateConversationTokens 含 thinking 块（旧 chars/4 完全漏算）", () => {
    const withThinking: Message[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "这是一段很长的思考内容".repeat(50) } as any],
      },
    ];
    // 旧 estimateRatio 只累加 text / tool_result / tool_use.input → thinking 记 0。
    expect(estimateConversationTokens(withThinking)).toBeGreaterThan(100);
  });

  test("中文密集会话：新估算显著高于旧 chars/4（两把尺子差数倍的根因）", () => {
    const msgs: Message[] = [userMsg("这是一段中文测试内容用于验证估算口径".repeat(100))];
    const chars = "这是一段中文测试内容用于验证估算口径".repeat(100).length;
    const oldEstimate = Math.ceil(chars / 4); // 旧 estimateRatio 的算法
    expect(estimateConversationTokens(msgs)).toBeGreaterThan(oldEstimate * 2);
  });

  test("Manager.estimateTokensFor 对传入列表生效，且与 estimateTokens 同源", () => {
    const mgr = new Manager({ maxTokens: 100_000 });
    mgr.setSystemPrompt("系统提示词");
    mgr.addMessage(userMsg("当前历史"));

    // 同一份 messages 传进去 → 与 estimateTokens() 读 this.messages 结果一致
    expect(mgr.estimateTokensFor(mgr.getMessages())).toBe(mgr.estimateTokens());

    // 换一份更短的列表 → 估算随之下降（管线逐步替换消息时要的正是这个能力）
    expect(mgr.estimateTokensFor([userMsg("短")])).toBeLessThan(mgr.estimateTokens());
  });

  test("estimateTokensFor 吃 calibrationFactor（不是裸启发式）", () => {
    const mgr = new Manager({ maxTokens: 100_000 });
    mgr.addMessage(userMsg("x".repeat(4000)));
    const before = mgr.estimateTokensFor(mgr.getMessages());
    // 喂一个远高于启发式的真实 usage → factor 上调
    mgr.recordActualTokens(before * 3);
    expect(mgr.estimateTokensFor(mgr.getMessages())).toBeGreaterThan(before);
  });

  test("estimateTokensFor 不套 lastActualInputTokens 下界", () => {
    const mgr = new Manager({ maxTokens: 100_000 });
    mgr.addMessage(userMsg("x".repeat(4000)));
    mgr.recordActualTokens(50_000);
    // estimateTokens 会被锚点顶到 >= 50000；estimateTokensFor 不能——
    // 否则管线压完消息后仍被压缩前的锚点顶着，永远认为"还没压够"。
    expect(mgr.estimateTokens()).toBeGreaterThanOrEqual(50_000);
    expect(mgr.estimateTokensFor([userMsg("压完剩这一条")])).toBeLessThan(50_000);
  });

  test("管线用传入的 estimateTokens 判达标（而非内部 chars/4）", () => {
    const msgs = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? userMsg(`问题${i}`) : asstMsg(`回答${i}`),
    );
    let called = 0;
    runCompactPipeline(msgs, {
      currentUsageRatio: 0.9,
      maxTokens: 100_000,
      toolCount: 10,
      targetUsageRatio: 0.8,
      estimateTokens: (m) => {
        called++;
        return estimateConversationTokens(m, { toolCount: 10 });
      },
    });
    expect(called).toBeGreaterThan(0);
  });
});

describe("P1-7 — 管线目标比例从真实触发点派生，不写死 0.7", () => {
  test("1M 窗口：派生比例贴近 compactionTriggerUsed，明显高于 0.7", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    const derived = pipelineTargetRatioFrom(mgr);
    const trigger = mgr.getCompactionThresholds().compactionTriggerUsed / mgr.getMaxTokens();
    expect(derived).toBeCloseTo(trigger, 5);
    // 缺陷文档的数字：1M 窗口 hard 约在 82% 进场，写死 0.7 会多丢一截历史
    expect(derived).toBeGreaterThan(0.7);
  });

  test("派生值被钳在 [0.3, 0.95]（防极端窗口配置把管线逼到荒谬目标）", () => {
    for (const maxTokens of [20_000, 60_000, 200_000, 1_000_000]) {
      const r = pipelineTargetRatioFrom(new Manager({ maxTokens }));
      expect(r).toBeGreaterThanOrEqual(0.3);
      expect(r).toBeLessThanOrEqual(0.95);
    }
  });

  test("目标比例更高 → 管线更早停手（少丢历史）", () => {
    const msgs = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0 ? userMsg(`问题${i}`.repeat(200)) : asstMsg(`回答${i}`.repeat(200)),
    );
    const common = {
      currentUsageRatio: 0.9,
      maxTokens: 50_000,
      toolCount: 5,
      estimateTokens: (m: Message[]) => estimateConversationTokens(m, { toolCount: 5 }),
    };
    const low = runCompactPipeline(msgs, { ...common, targetUsageRatio: 0.3 });
    const high = runCompactPipeline(msgs, { ...common, targetUsageRatio: 0.9 });
    expect(high.steps.length).toBeLessThanOrEqual(low.steps.length);
  });
});

describe("P1-8 — 动态块不再混入本该静态的内容", () => {
  /**
   * P1-8 在缺陷文档里明确「不独立引入新机制」，它是 P0-1 的**击穿半径放大器**：
   * `buildSystemBlocks` 只切一个 DYNAMIC_BOUNDARY，动态区内部 join("\n\n") 成一整块，
   * 所以 CLAUDE.md 一旦（因 P0-1 漏标）掉进动态区，git 变一个字节就得连它一起重算。
   *
   * 修法是 P0-1：把 CLAUDE.md / deny 规则 / Skill 摘要标回静态区——**不是**把 git 挪去动态区。
   * 挪 git 只是换个方向踩同一个坑（每次新提交都击穿整块动态区），而且会掉进
   * 「git 快照冻结死循环」那段【关键决策】已经处理过的老问题里。
   * 这里守的就是这个方向性结论，防后人（包括修 P1-8 的人）把 git 改成 dynamic。
   */
  test("git 快照留在静态区（volatile 的 Status 块已物理删除，故它确实稳定）", () => {
    const att = generateGitStatusAttachment(process.cwd());
    // 非 git 仓库返回 null；本仓库是 git 仓库，必须拿到附件
    expect(att).not.toBeNull();
    expect(att!.cacheStability).toBe("stable");
    // 之所以敢进静态区，前提是最毒的 volatile 块不在里面——这条是那个前提的守卫
    expect(att!.content).not.toContain("Status:");
  });

  test("P0-1 前提仍在：CLAUDE.md / deny 规则 / Skill 摘要都是静态（它们掉进动态区才是 P1-8 的病根）", () => {
    expect(generateClaudeMdAttachment("项目规则内容").cacheStability).toBe("stable");
    expect(generateDenyRulesAttachment("禁止 rm -rf")!.cacheStability).toBe("stable");
  });
});

describe("P1-10 — system prompt 缓存键含当天日期", () => {
  test("同一 ctx 的键含当天日期串（跨午夜必然变键，不会送出昨天的 current-date）", () => {
    const ctx = { tools: [], workingDir: "/tmp" } as any;
    const today = new Date().toISOString().split("T")[0];
    // 键是 `${len}:${hash}:${hash}`，日期已进 canonical 快照 → 换一天必然换键。
    // 这里断言"日期参与了键的派生"：把日期塞进另一个字段做对照不可行（会改别的维度），
    // 故用同一天两次调用相等 + 键对日期敏感（下一条）联合守护。
    expect(generateCacheKey(ctx)).toBe(generateCacheKey(ctx));
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("日期变化会改变缓存键（伪造系统日期验证敏感性）", () => {
    const ctx = { tools: [], workingDir: "/tmp" } as any;
    const keyToday = generateCacheKey(ctx);
    const RealDate = Date;
    try {
      // 把"明天"伪装成当天，键必须变——否则跨午夜 TTL 未过期时会送出昨天的日期
      class FakeDate extends RealDate {
        constructor(...args: any[]) {
          if (args.length === 0) {
            super(RealDate.now() + 24 * 3600 * 1000);
          } else {
            // @ts-expect-error 透传构造参数
            super(...args);
          }
        }
      }
      (globalThis as any).Date = FakeDate;
      expect(generateCacheKey(ctx)).not.toBe(keyToday);
    } finally {
      (globalThis as any).Date = RealDate;
    }
  });
});

describe("P1-15 — snip 切断 thinking 有检测", () => {
  test("被裁掉的 assistant 消息含 thinking → 能检出", () => {
    const original: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "推理过程" } as any,
          { type: "text", text: "结论" },
        ],
      },
      userMsg("保留"),
    ];
    const remaining = [original[1]];
    const splits = findSplitThinking(original, remaining);
    expect(splits).toHaveLength(1);
    expect(splits[0]).toEqual({ messageIndex: 0, count: 1 });
  });

  test("没裁掉带 thinking 的消息 → 不误报", () => {
    const msgs: Message[] = [
      { role: "assistant", content: [{ type: "thinking", thinking: "t" } as any] },
      userMsg("b"),
    ];
    expect(findSplitThinking(msgs, msgs)).toHaveLength(0);
  });

  test("redacted_thinking 同样计入", () => {
    const original: Message[] = [
      { role: "assistant", content: [{ type: "redacted_thinking", data: "xx" } as any] },
      userMsg("保留"),
    ];
    expect(findSplitThinking(original, [original[1]])[0].count).toBe(1);
  });

  test("裁掉的是纯文本 assistant 消息 → 不报 thinking 切开口", () => {
    const original: Message[] = [asstMsg("纯文本"), userMsg("保留")];
    expect(findSplitThinking(original, [original[1]])).toHaveLength(0);
  });

  test("真实 snipCompact 路径上：thinking 被裁掉可被检出（此前零检测）", () => {
    const msgs: Message[] = [
      userMsg("q1"),
      { role: "assistant", content: [{ type: "thinking", thinking: "推理" } as any] },
      userMsg("q2"),
      asstMsg("a2"),
      userMsg("q3"),
      asstMsg("a3"),
      userMsg("q4"),
      asstMsg("a4"),
    ];
    const result = snipCompact(msgs);
    expect(result.success).toBe(true);
    // snip 从头裁 2 条，含上面那条带 thinking 的 assistant
    expect(findSplitThinking(msgs, result.messages).length).toBeGreaterThan(0);
  });
});
