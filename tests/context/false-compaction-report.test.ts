/**
 * 假压缩误报防回归守卫 — docs/bugfixes/todo/假压缩误报与Footer上下文占用率失真 §八
 *
 * 背景（2026-07-29 事故）：TUI 弹出「对话已压缩」，但消息历史一条都没少；会话峰值占用只有
 * 17.6%，任何阈值压缩路径都没触发过。链路是：模型吐坏 JSON → 空参数重试路径**无条件**调压缩
 * → 压缩函数因找不到安全分割点**静默 no-op** → 但**硬编码返回 success: true** → 画横幅 +
 * 给模型注入「系统已为你精简对话上下文」。那句假话进上下文后，模型此后 30 条回复持续自我否定。
 *
 * 本文件锁住两条架构不变式（对齐 CC）：
 *   1. 压缩的「成功」必须由实测前后差值定义，不能由代码路径宣告。
 *   2. 压缩的 UI 表示必须从压缩结果派生，不能是独立信号。
 *
 * 覆盖 §八 的 #1 #2 #8 #9 #10 #11（消息层不变式）。
 * 空参数门禁/横幅/熔断（#3 #4 #5 #12 #13 #14）在 tests/query/ 下另有专测。
 *
 * fix_type: infra_bug（L1，测试）
 */

import { describe, test, expect } from "bun:test";
import { Manager as ContextManager } from "../../src/context/manager.ts";
import { MessageValidator } from "../../src/context/validator.ts";
import { checkMessageHistoryIntegrity } from "../../src/agent/message-invariants.ts";
import { reactiveCompact } from "../../src/query/reactive-compact.ts";
import type { Message } from "../../src/llm/types.ts";

/**
 * 构造「agent 典型历史」：user 消息几乎全部承载 tool_result。
 *
 * 这正是事故会话的形态——156 条历史、78 条 user 消息，而旧 findCompressSplitPoint 只认
 * 「role===user 且不含 tool_result」的切点，合格的只有 2 个（其中 1 个在下标 0 且被
 * `lastSafePoint > 0` 排除）→ 恒返回 0 → 策略 1 与策略 2 同时 no-op，压缩能力恒为零。
 */
function buildAgentHistory(rounds: number, pad = 400): Message[] {
  const msgs: Message[] = [
    { role: "user", content: [{ type: "text", text: "请帮我重构这个模块" }] },
  ];
  for (let i = 0; i < rounds; i++) {
    msgs.push({
      role: "assistant",
      content: [
        { type: "text", text: `第 ${i} 步` },
        { type: "tool_use", id: `t${i}`, name: i % 2 ? "edit" : "read", input: { path: `f${i}.ts`, pad: "p".repeat(pad) } },
      ],
    });
    // 关键：user 消息只含 tool_result（agent 工作流的常态）
    msgs.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(pad) }],
    });
  }
  return msgs;
}

describe("§八 #11 / #1 — agent 典型历史下压缩必须真的生效", () => {
  test("#11 正向验收：user 消息几乎全含 tool_result 时，compactWithSummary 仍能成功", () => {
    const ctx = new ContextManager({ maxTokens: 1_000_000 });
    ctx.setMessages(buildAgentHistory(40));
    const before = ctx.messageCount();

    const outcome = ctx.compactWithSummary("【摘要】前面重构了若干文件。");

    // 这是本 bug 的核心场景：修复前 splitPoint 恒为 0 → 静默 no-op
    expect(outcome.success).toBe(true);
    expect(outcome.messageCountAfter).toBeLessThan(before);
    expect(outcome.splitPoint).toBeGreaterThan(0);
    expect(ctx.messageCount()).toBe(outcome.messageCountAfter);
  });

  test("#11 reactiveCompact 在同一形态下必须真正减少消息数（而非谎报）", () => {
    const ctx = new ContextManager({ maxTokens: 1_000_000 });
    ctx.setMessages(buildAgentHistory(40));
    const before = ctx.messageCount();

    const result = reactiveCompact(ctx);

    expect(result.success).toBe(true);
    expect(result.messageCountAfter).toBeLessThan(before);
    // 实测差值必须与管理器的真实状态一致（不允许"报告值"与"实际值"脱节）
    expect(ctx.messageCount()).toBe(result.messageCountAfter);
  });

  test("#1 消息太少无法压缩时，reactiveCompact 必须如实返回 false", () => {
    const ctx = new ContextManager({ maxTokens: 1_000_000 });
    ctx.setMessages([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);

    const result = reactiveCompact(ctx);

    expect(result.success).toBe(false);
    expect(result.messageCountAfter).toBe(result.messageCountBefore);
    expect(ctx.messageCount()).toBe(2); // 一条都不该动
  });
});

/**
 * 用桩替换压缩原语，**隔离**验证 reactiveCompact 自身的判定逻辑。
 *
 * 为什么必须隔离：P0-5 修好之后，真实历史下压缩几乎总能成功，于是「策略 1 硬编码
 * success: true」这个 P0-1 原 bug 在端到端测试里**观察不到**（变异测试实测：把
 * `if (outcome.success)` 改回 `if (true)`，端到端 9 条断言全过）。只有把压缩原语打成
 * 可控失败，才能锁住"success 必须取自实测结果"这条契约本身。
 */
class StubManager extends ContextManager {
  compactCalls = 0;
  emergencyCalls = 0;
  constructor(
    private readonly plan: { compactSucceeds: boolean; emergencySucceeds: boolean },
    msgs: Message[],
  ) {
    super({ maxTokens: 1_000_000 });
    this.setMessages(msgs);
  }
  override compactWithSummary(summary: string, extra?: Message[]) {
    this.compactCalls++;
    if (this.plan.compactSucceeds) return super.compactWithSummary(summary, extra);
    const n = this.messageCount();
    return {
      success: false as const,
      messageCountBefore: n,
      messageCountAfter: n,
      tokensBefore: 0,
      tokensAfter: 0,
      splitPoint: 0,
      reason: "no_split_point" as const,
    };
  }
  override emergencyTruncate() {
    this.emergencyCalls++;
    if (this.plan.emergencySucceeds) return super.emergencyTruncate();
    const n = this.messageCount();
    return {
      success: false as const,
      messageCountBefore: n,
      messageCountAfter: n,
      tokensBefore: 0,
      tokensAfter: 0,
      splitPoint: 0,
      reason: "no_split_point" as const,
    };
  }
}

describe("§八 #1 — reactiveCompact 的 success 必须取自实测，不得由代码路径宣告", () => {
  test("两个策略都 no-op ⟹ success=false 且消息数一条不变（守 P0-1 硬编码 true）", () => {
    const stub = new StubManager(
      { compactSucceeds: false, emergencySucceeds: false },
      buildAgentHistory(40),
    );
    const before = stub.messageCount();

    const result = reactiveCompact(stub);

    // ★这是本 bug 的原始形态：压缩静默 no-op，却上报成功 → 画横幅 + 骗模型
    expect(result.success).toBe(false);
    expect(result.messageCountAfter).toBe(before);
    expect(stub.messageCount()).toBe(before);
    expect(result.strategy).toBe("none");
  });

  test("策略 1 no-op ⟹ 必须降级尝试策略 2（守「策略2 永远走不到」）", () => {
    const stub = new StubManager(
      { compactSucceeds: false, emergencySucceeds: true },
      buildAgentHistory(40),
    );
    const before = stub.messageCount();

    const result = reactiveCompact(stub);

    // 旧代码在策略 1 里直接 return success:true，导致 emergencyTruncate 永远不被调用
    expect(stub.compactCalls).toBe(1);
    expect(stub.emergencyCalls).toBe(1);
    expect(result.success).toBe(true);
    expect(result.strategy).toBe("emergency");
    expect(result.messageCountAfter).toBeLessThan(before);
    expect(stub.messageCount()).toBe(result.messageCountAfter);
  });
});

describe("§八 #2 — success: true ⟹ messageCountAfter < messageCountBefore（属性测试）", () => {
  test("任意历史形态下该蕴含式恒成立（compactWithSummary / emergencyTruncate / reactiveCompact）", () => {
    // 覆盖多种规模与形态：空/极短/纯文本/全 tool_result/混合
    const shapes: Array<() => Message[]> = [
      () => [],
      () => [{ role: "user", content: [{ type: "text", text: "only one" }] }],
      () => buildAgentHistory(1),
      () => buildAgentHistory(3, 50),
      () => buildAgentHistory(40),
      () => buildAgentHistory(80, 100),
      // 纯文本交替历史（无任何工具调用）
      () =>
        Array.from({ length: 30 }, (_, i) => ({
          role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
          content: [{ type: "text" as const, text: `消息 ${i} ${"y".repeat(200)}` }],
        })),
    ];

    for (const [idx, make] of shapes.entries()) {
      for (const op of ["compact", "emergency", "reactive"] as const) {
        const ctx = new ContextManager({ maxTokens: 1_000_000 });
        const msgs = make();
        if (msgs.length > 0) ctx.setMessages(msgs);
        const before = ctx.messageCount();

        const outcome =
          op === "compact"
            ? ctx.compactWithSummary("【摘要】x")
            : op === "emergency"
              ? ctx.emergencyTruncate()
              : reactiveCompact(ctx);

        const after = ctx.messageCount();
        const label = `shape#${idx}/${op}`;

        // 核心不变式：报成功 ⟹ 消息数确实下降
        if (outcome.success) {
          expect(after, label).toBeLessThan(before);
        } else {
          // 报失败 ⟹ 消息数一条都不许变（no-op 或已回滚）
          expect(after, label).toBe(before);
        }
        // 报告值与实际状态必须一致
        expect(outcome.messageCountAfter, label).toBe(after);
        expect(outcome.messageCountBefore, label).toBe(before);
      }
    }
  });
});

describe("§八 #9 / #10 — 放宽分割点后的协议安全（P0-5 的必要配套）", () => {
  test("#9 压缩后不得出现孤儿 tool_use / 游离 tool_result，且结构校验为零错误", () => {
    for (const rounds of [5, 12, 40, 80]) {
      const ctx = new ContextManager({ maxTokens: 1_000_000 });
      ctx.setMessages(buildAgentHistory(rounds));
      expect(checkMessageHistoryIntegrity(ctx.getMessages()).intact).toBe(true); // 基线

      ctx.compactWithSummary("【摘要】压缩安全性检查");

      const after = ctx.getMessages();
      const integrity = checkMessageHistoryIntegrity(after);
      expect(integrity.intact, `rounds=${rounds}`).toBe(true);
      expect(integrity.orphans, `rounds=${rounds}`).toHaveLength(0);
      expect(integrity.dangling, `rounds=${rounds}`).toHaveLength(0);
      // 结构规则（首条为 user、角色交替、content 非空）也必须过——
      // 放宽切点后切点可能落在 assistant 上，这是新增的风险面
      expect(MessageValidator.validate(after), `rounds=${rounds}`).toHaveLength(0);
    }
  });

  test("#9 emergencyTruncate 同样必须产出合法序列", () => {
    for (const rounds of [5, 12, 40]) {
      const ctx = new ContextManager({ maxTokens: 1_000_000 });
      ctx.setMessages(buildAgentHistory(rounds));

      ctx.emergencyTruncate();

      const after = ctx.getMessages();
      expect(checkMessageHistoryIntegrity(after).intact, `rounds=${rounds}`).toBe(true);
      expect(MessageValidator.validate(after), `rounds=${rounds}`).toHaveLength(0);
    }
  });

  test("#10 extraReattach 破坏角色交替时必须回滚（守 P2-3 阻塞式校验）", () => {
    // extraReattach 来自外部调用方（auto-compact.ts 的文件恢复 / 决策点恢复），
    // 是"非法序列"最现实的入口：一条 role 与前后冲突的消息就能让整段历史违反交替规则。
    // 修复前校验只 warn 不阻塞 → 非法历史被发出去 → provider 400。
    const ctx = new ContextManager({ maxTokens: 1_000_000 });
    ctx.setMessages(buildAgentHistory(40));
    const before = ctx.messageCount();
    const snapshot = JSON.stringify(ctx.getMessages());

    // 连续两条 assistant：插到摘要前缀之后必然产生 ROLE_NOT_ALTERNATING
    const badReattach: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "非法重注入 A" }] },
      { role: "assistant", content: [{ type: "text", text: "非法重注入 B" }] },
    ];

    const outcome = ctx.compactWithSummary("【摘要】带非法重注入", badReattach);

    // ★必须回滚：宁可不压，也不能把非法序列提交进历史
    expect(outcome.success).toBe(false);
    expect(outcome.reason).toBe("invalid_result_rolled_back");
    expect(ctx.messageCount()).toBe(before);
    expect(JSON.stringify(ctx.getMessages())).toBe(snapshot);
    // 回滚后历史仍然完全合法（可继续正常发送）
    expect(MessageValidator.validate(ctx.getMessages())).toHaveLength(0);
    expect(checkMessageHistoryIntegrity(ctx.getMessages()).intact).toBe(true);
  });

  test("#10 extraReattach 带游离 tool_result 时必须回滚（配对校验侧）", () => {
    const ctx = new ContextManager({ maxTokens: 1_000_000 });
    ctx.setMessages(buildAgentHistory(40));
    const before = ctx.messageCount();

    // tool_result 指向一个不存在的 tool_use → dangling，provider 会直接 400
    const badReattach: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "does-not-exist", content: "野结果" }],
      },
      { role: "assistant", content: [{ type: "text", text: "收到" }] },
    ];

    const outcome = ctx.compactWithSummary("【摘要】带游离 tool_result", badReattach);

    expect(outcome.success).toBe(false);
    expect(outcome.reason).toBe("invalid_result_rolled_back");
    expect(ctx.messageCount()).toBe(before);
    expect(checkMessageHistoryIntegrity(ctx.getMessages()).intact).toBe(true);
  });

  test("#10 emergencyTruncate 切点不安全时也必须回滚（守两处校验各自生效）", () => {
    /**
     * emergencyTruncate 与 compactWithSummary 各有一份「校验不过就回滚」，必须**各自**被守住
     * （变异测试实证：只测 compactWithSummary 时，短路 emergencyTruncate 的校验无人发现）。
     *
     * 正常路径下 collectSafeSplitPoints 保证切点安全，因此这里显式强制一个**不安全**切点：
     * 切在承载 tool_result 的 user 消息上 → 该 tool_result 与它的 tool_use 失联（游离）→
     * 多数 provider 直接 400。这是"防线本身还在不在"的直接检验。
     */
    class ForcedBadSplit extends ContextManager {
      override findCompressSplitPoint(): number {
        // 定位第一条"只含 tool_result"的 user 消息：切在它上面必然产生游离 tool_result
        const msgs = this.getMessages();
        for (let i = 1; i < msgs.length; i++) {
          if (msgs[i].role === "user" && msgs[i].content.some((b) => b.type === "tool_result")) {
            return i;
          }
        }
        return 0;
      }
    }

    const ctx = new ForcedBadSplit({ maxTokens: 1_000_000 });
    ctx.setMessages(buildAgentHistory(40));
    const before = ctx.messageCount();
    const snapshot = JSON.stringify(ctx.getMessages());

    const outcome = ctx.emergencyTruncate();

    // ★宁可不截断，也不能提交一个 provider 会拒的序列
    expect(outcome.success).toBe(false);
    expect(outcome.reason).toBe("invalid_result_rolled_back");
    expect(ctx.messageCount()).toBe(before);
    expect(JSON.stringify(ctx.getMessages())).toBe(snapshot);
    expect(checkMessageHistoryIntegrity(ctx.getMessages()).intact).toBe(true);
  });

  test("#10 无安全分割点时回滚：消息数不变且 success=false，附失败原因", () => {
    // 构造一个「切开必然产生游离 tool_result」的历史：
    // 首条 user 就带 tool_result，且其 tool_use 在更早的位置不存在——
    // 此时除下标 0 外没有任何安全切点，而 0 不被接受（切了等于没切）。
    const ctx = new ContextManager({ maxTokens: 1_000_000 });
    ctx.setMessages([
      { role: "user", content: [{ type: "text", text: "开始" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "only", name: "read", input: { p: "x".repeat(2000) } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "only", content: "y".repeat(2000) }] },
    ]);
    const before = ctx.messageCount();
    const snapshot = JSON.stringify(ctx.getMessages());

    const outcome = ctx.compactWithSummary("【摘要】不该生效");

    if (!outcome.success) {
      // 失败路径：必须一条都没动，且给出可归因的 reason
      expect(ctx.messageCount()).toBe(before);
      expect(JSON.stringify(ctx.getMessages())).toBe(snapshot);
      expect(outcome.reason).toBeDefined();
    } else {
      // 若确实找到了合法切点，则结果必须合法（不能以"切坏了"换取"压缩成功"）
      expect(outcome.messageCountAfter).toBeLessThan(before);
      expect(checkMessageHistoryIntegrity(ctx.getMessages()).intact).toBe(true);
      expect(MessageValidator.validate(ctx.getMessages())).toHaveLength(0);
    }
  });
});

describe("§八 #8 — emergencyTruncate no-op 时不得谎报「紧急压缩: N → M」", () => {
  test("splitPoint 为 0（历史过短）时返回 success=false 且 reason 可归因", () => {
    const ctx = new ContextManager({ maxTokens: 1_000_000 });
    ctx.setMessages([{ role: "user", content: [{ type: "text", text: "就一条" }] }]);

    const outcome = ctx.emergencyTruncate();

    // 修复前：无 else 分支 + 末尾无条件打印「紧急压缩: 1 → 1」，且返回 void 上层无从察觉
    expect(outcome.success).toBe(false);
    expect(outcome.reason).toBe("no_split_point");
    expect(outcome.messageCountAfter).toBe(outcome.messageCountBefore);
    expect(ctx.messageCount()).toBe(1);
  });

  test("成功与失败必须可区分：同一历史两次截断，第二次不应再谎报成功", () => {
    const ctx = new ContextManager({ maxTokens: 1_000_000 });
    ctx.setMessages(buildAgentHistory(40));

    const first = ctx.emergencyTruncate();
    expect(first.success).toBe(true);

    // 反复截断直到压不动，压不动那次必须如实返回 false（而非无限"成功"）
    let last = first;
    for (let i = 0; i < 20 && last.success; i++) {
      const n = ctx.messageCount();
      last = ctx.emergencyTruncate();
      if (last.success) expect(ctx.messageCount()).toBeLessThan(n);
      else expect(ctx.messageCount()).toBe(n);
    }
    expect(last.success).toBe(false);
    expect(last.messageCountAfter).toBe(last.messageCountBefore);
  });
});
