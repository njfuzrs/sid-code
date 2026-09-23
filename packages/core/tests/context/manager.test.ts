/**
 * 上下文管理器测试
 */

import { describe, test, expect } from "bun:test";
import { Manager } from "@sid-code/core/context/manager.ts";

describe("ContextManager", () => {
  test("添加和获取消息", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "你好" }],
    });
    mgr.addMessage({
      role: "assistant",
      content: [{ type: "text", text: "你好！有什么可以帮你的？" }],
    });

    expect(mgr.messageCount()).toBe(2);
    const msgs = mgr.getMessages();
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
  });

  test("系统提示词设置和获取", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    mgr.setSystemPrompt("你是一个编程助手");
    expect(mgr.getSystemPrompt()).toBe("你是一个编程助手");
  });

  test("token 估算", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    mgr.setSystemPrompt("a".repeat(400)); // ~100 tokens
    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "b".repeat(200) }], // ~50 tokens
    });

    const tokens = mgr.estimateTokens();
    expect(tokens).toBeGreaterThan(100);
  });

  test("token 估算包含工具定义开销", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    const baseTokens = mgr.estimateTokens(0);
    const withTools = mgr.estimateTokens(6); // 6 个工具

    // 6 个工具 × 80 token/工具 = 480 token 开销
    expect(withTools - baseTokens).toBe(480);
  });

  test("token 估算包含消息结构开销", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    const before = mgr.estimateTokens();

    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "" }], // 空文本，只有结构开销
    });

    const after = mgr.estimateTokens();
    // 每条消息 4 token 结构开销
    expect(after - before).toBe(4);
  });

  test("token 估算 tool_use 块包含额外开销", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "test" }],
    });
    mgr.addMessage({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "c1",
          name: "read",
          input: {},
        },
      ],
    });

    const tokens = mgr.estimateTokens();
    // 应包含 tool_use 的 20 token 结构开销
    expect(tokens).toBeGreaterThan(20);
  });

  test("needsCompaction 支持 toolCount 参数", () => {
    const mgr = new Manager({ maxTokens: 1000, compactThreshold: 0.5 });
    // 不带工具时不需要压缩
    expect(mgr.needsCompaction(0)).toBe(false);
    // 带大量工具时可能需要压缩（6 × 80 = 480 > 500 阈值）
    expect(mgr.needsCompaction(7)).toBe(true); // 7 × 80 = 560 > 500
  });

  test("compactWithSummary 用摘要替换历史", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    // 添加 20 条消息（10 轮对话），确保有足够消息触发压缩
    for (let i = 0; i < 20; i++) {
      mgr.addMessage({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `消息 ${i} ${"x".repeat(100)}` }],
      });
    }

    const before = mgr.messageCount();
    expect(before).toBe(20);
    mgr.compactWithSummary("这是之前对话的摘要");

    // 压缩后消息数应减少（摘要 + 确认 + 保留的近期消息）
    expect(mgr.messageCount()).toBeLessThan(before);
    const msgs = mgr.getMessages();
    expect(msgs[0].content[0]).toHaveProperty("text");
    expect((msgs[0].content[0] as any).text).toContain("对话摘要");
  });

  test("clear 清空所有消息", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "test" }],
    });
    mgr.clear();
    expect(mgr.messageCount()).toBe(0);
  });

  test("getMaxTokens 返回配置的最大 token 数", () => {
    const mgr = new Manager({ maxTokens: 200000 });
    expect(mgr.getMaxTokens()).toBe(200000);
  });

  test("§12 复审：needsCompaction 与 getCompactionLevel 同源（不再用 0.7 比例独立判定）", () => {
    // 历史行为：needsCompaction 用 maxTokens×compactThreshold(0.7) 独立判定，与真实压缩链路
    // （绝对 buffer + 相对系数 + 完成缓冲区）不同源 —— 会给调用方错误信号。
    // 现在语义 = 已达 hard 档或更紧急，两者恒等。
    const mgr = new Manager({ maxTokens: 1000 }); // 小窗口：默认无 hard 档，仅 emergency
    mgr.setSystemPrompt("a".repeat(3300)); // ~660 tokens，剩余 340 > 100 门槛
    expect(mgr.getCompactionLevel(0)).toBe("none");
    expect(mgr.needsCompaction(0)).toBe(false);

    mgr.setSystemPrompt("a".repeat(4600)); // ~920 tokens，剩余 80 ≤ 100 → emergency
    expect(mgr.getCompactionLevel(0)).toBe("emergency");
    expect(mgr.needsCompaction(0)).toBe(true);

    // 标准窗口：needsCompaction 恒等于「level ∈ {hard, emergency}」
    const std = new Manager({ maxTokens: 200_000 });
    std.setSystemPrompt("a".repeat(Math.ceil(140_000 / 0.2))); // 恰好到 70% 触发点
    expect(std.needsCompaction(0)).toBe(["hard", "emergency"].includes(std.getCompactionLevel(0)));
    expect(std.needsCompaction(0)).toBe(true);
  });

  test("compactWithSummary 使用安全分割点压缩", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    // 添加 20 条消息（10 轮对话），确保有足够内容触发分割
    for (let i = 0; i < 20; i++) {
      mgr.addMessage({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `消息 ${i} ${"x".repeat(100)}` }],
      });
    }
    expect(mgr.messageCount()).toBe(20);

    mgr.compactWithSummary("摘要内容");
    // 压缩后消息数应减少，且第一条是摘要
    expect(mgr.messageCount()).toBeLessThan(20);
    const msgs = mgr.getMessages();
    expect((msgs[0].content[0] as any).text).toContain("对话摘要");
    expect((msgs[1].content[0] as any).text).toContain("了解");
  });
});

describe("truncateToolOutput 智能截断", () => {
  test("短内容不截断", () => {
    const content = "hello world";
    expect(Manager.truncateToolOutput(content)).toBe(content);
  });

  test("普通文本：70% 头 + 30% 尾", () => {
    // 生成超过 30000 字符的普通文本
    const content = "x".repeat(50000);
    const result = Manager.truncateToolOutput(content);

    expect(result.length).toBeLessThan(content.length);
    expect(result).toContain("省略约");
    expect(result).toContain("字符");
    // 头部应该是原始内容的前 70%
    expect(result.startsWith("x".repeat(100))).toBe(true);
    // 尾部应该是原始内容的后 30%
    expect(result.endsWith("x".repeat(100))).toBe(true);
  });

  test("文件内容（行号特征 →）：保留前 20 行 + 后 10 行", () => {
    // 生成带行号特征的超长内容
    const lines = Array.from({ length: 100 }, (_, i) => `${i + 1}→ line content ${i}`);
    const content = lines.join("\n");
    // 确保超过阈值
    const padded = content + "\n" + "x".repeat(30000);
    const result = Manager.truncateToolOutput(padded);

    expect(result).toContain("1→ line content 0"); // 头部
    expect(result).toContain("省略");
    expect(result).toContain("行");
  });

  test("文件内容（行号特征 │）：保留前 20 行 + 后 10 行", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `  ${i + 1} │ line content ${i}`);
    const content = lines.join("\n");
    const padded = content + "\n" + "x".repeat(30000);
    const result = Manager.truncateToolOutput(padded);

    expect(result).toContain("1 │ line content 0");
    expect(result).toContain("省略");
  });

  test("代码块：保留 60% 头 + 40% 尾", () => {
    // 生成包含大代码块的内容
    const codeLines = Array.from({ length: 200 }, (_, i) => `  const x${i} = ${i};`);
    const content =
      "前面的文本\n```typescript\n" +
      codeLines.join("\n") +
      "\n```\n后面的文本" +
      "x".repeat(30000);
    const result = Manager.truncateToolOutput(content);

    // 代码块应该被压缩
    expect(result).toContain("省略");
  });

  test("自定义 maxChars 参数", () => {
    const content = "a".repeat(2000);
    const result = Manager.truncateToolOutput(content, 1000);

    expect(result.length).toBeLessThan(content.length);
    expect(result).toContain("省略约");
  });
});

describe("增量压缩", () => {
  test("addMessage 自动截断超大 tool_result (非豁免工具)", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    const bigContent = "x".repeat(50000);

    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "test" }],
    });
    mgr.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "bash", input: {} }],
    });
    mgr.addMessage({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "c1",
          content: bigContent,
          is_error: false,
        },
      ],
    });

    const msgs = mgr.getMessages();
    const toolResult = msgs[2].content[0];
    expect(toolResult.type).toBe("tool_result");
    if (toolResult.type === "tool_result") {
      // 应该被持久化到磁盘，content 变为 ~200 字节的轻量引用
      expect(toolResult.content.length).toBeLessThan(bigContent.length);
      expect(toolResult.content).toContain("[持久化输出]");
      expect(toolResult.content).toContain("tool_use_id=c1");
      expect(toolResult.content).toContain("tool=bash");
    }
  });

  test("addMessage 豁免 read/edit/write 工具的大输出（不立即持久化）", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    const bigContent = "x".repeat(50000);

    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "test" }],
    });
    mgr.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "read", input: {} }],
    });
    mgr.addMessage({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "c1",
          content: bigContent,
          is_error: false,
        },
      ],
    });

    const msgs = mgr.getMessages();
    const toolResult = msgs[2].content[0];
    expect(toolResult.type).toBe("tool_result");
    if (toolResult.type === "tool_result") {
      // read 工具豁免即时持久化，内容应保持原样
      expect(toolResult.content.length).toBe(bigContent.length);
      expect(toolResult.content).not.toContain("[持久化输出]");
    }
  });

  test("addMessage 不截断小的 tool_result", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    const smallContent = "小输出内容";

    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "test" }],
    });
    mgr.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "read", input: {} }],
    });
    mgr.addMessage({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "c1",
          content: smallContent,
          is_error: false,
        },
      ],
    });

    const msgs = mgr.getMessages();
    const toolResult = msgs[2].content[0];
    if (toolResult.type === "tool_result") {
      expect(toolResult.content).toBe(smallContent);
    }
  });

  test("P1-7：recordActualTokens 校准估算向真实 usage 收敛", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    mgr.addMessage({ role: "user", content: [{ type: "text", text: "x".repeat(10_000) }] });
    const raw = mgr.estimateTokens(0);
    // 假设真实 input 是纯启发式估算的 2 倍 → factor 应趋向 2
    mgr.recordActualTokens(raw * 2, 0);
    const calibrated = mgr.estimateTokens(0);
    // 校准后应明显大于原始估算（向真实值靠拢），且不小于真实锚点
    expect(calibrated).toBeGreaterThan(raw);
    expect(calibrated).toBeGreaterThanOrEqual(raw * 2);
  });

  test("P1-6：estimateTokens 不低于上次真实输入锚点", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    mgr.addMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    // 真实输入 50000（远大于这条短消息的字符估算）
    mgr.recordActualTokens(50_000, 0);
    // compact 决策依赖的估算不应塌缩到字符估算的极小值，至少守住真实锚点
    expect(mgr.estimateTokens(0)).toBeGreaterThanOrEqual(50_000);
  });

  test("recordActualTokens 忽略非法真实值（0/负/NaN）", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    mgr.addMessage({ role: "user", content: [{ type: "text", text: "x".repeat(1000) }] });
    const before = mgr.estimateTokens(0);
    mgr.recordActualTokens(0, 0);
    mgr.recordActualTokens(-100, 0);
    mgr.recordActualTokens(NaN, 0);
    // 未校准，估算保持纯启发式不变
    expect(mgr.estimateTokens(0)).toBe(before);
  });

  test("P1-6：compactWithSummary 后真实锚点失效，估算回落（不再被旧高锚点钉死）", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    for (let i = 0; i < 12; i++) {
      mgr.addMessage({
        role: "user",
        content: [{ type: "text", text: `msg-${i} ${"x".repeat(200)}` }],
      });
      mgr.addMessage({ role: "assistant", content: [{ type: "text", text: `reply-${i}` }] });
    }
    // 锚定一个远高于压缩后真实量的值
    mgr.recordActualTokens(180_000, 0);
    expect(mgr.estimateTokens(0)).toBeGreaterThanOrEqual(180_000);
    // 压缩后真实 prompt 骤降，锚点必须失效，否则估算仍被钉在 180k → 刚压缩完又触发 compact
    mgr.compactWithSummary("早期对话摘要");
    expect(mgr.estimateTokens(0)).toBeLessThan(180_000);
  });

  test("P1-6：emergencyTruncate / setMessages / clear 均重置真实锚点", () => {
    // emergencyTruncate
    const m1 = new Manager({ maxTokens: 200_000 });
    for (let i = 0; i < 12; i++) {
      m1.addMessage({
        role: "user",
        content: [{ type: "text", text: `u${i} ${"x".repeat(200)}` }],
      });
      m1.addMessage({ role: "assistant", content: [{ type: "text", text: `a${i}` }] });
    }
    m1.recordActualTokens(180_000, 0);
    m1.emergencyTruncate();
    expect(m1.estimateTokens(0)).toBeLessThan(180_000);

    // setMessages
    const m2 = new Manager({ maxTokens: 200_000 });
    m2.addMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    m2.recordActualTokens(150_000, 0);
    m2.setMessages([{ role: "user", content: [{ type: "text", text: "short" }] }]);
    expect(m2.estimateTokens(0)).toBeLessThan(150_000);

    // clear
    const m3 = new Manager({ maxTokens: 200_000 });
    m3.addMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    m3.recordActualTokens(150_000, 0);
    m3.clear();
    expect(m3.estimateTokens(0)).toBeLessThan(150_000);
  });

  test("P2-3：setMaxTokens 更新上下文窗口，忽略非法值", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    expect(mgr.getMaxTokens()).toBe(200_000);
    mgr.setMaxTokens(1_000_000);
    expect(mgr.getMaxTokens()).toBe(1_000_000);
    // 非法值忽略，保持原窗口
    mgr.setMaxTokens(0);
    mgr.setMaxTokens(-5);
    mgr.setMaxTokens(NaN);
    expect(mgr.getMaxTokens()).toBe(1_000_000);
  });

  // ── P0-2：/context 分类 token 拆解 ──
  test("P0-2 getTokenBreakdown 各分类总和 ≈ estimateTokens", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    mgr.setSystemPrompt("你是一个编程助手" + "x".repeat(400));
    mgr.addMessage({ role: "user", content: [{ type: "text", text: "帮我修 bug" }] });
    mgr.addMessage({
      role: "assistant",
      content: [
        { type: "text", text: "好的，我来看看" },
        { type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } },
      ],
    });
    mgr.addMessage({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "文件内容".repeat(50) }],
    });

    const bd = mgr.getTokenBreakdown(6);
    // 分类总和应等于 categories 各项之和
    const sum = bd.categories.reduce((s, c) => s + c.tokens, 0);
    expect(bd.total).toBe(sum);
    // 与 estimateTokens 同口径（含工具 schema），允许小幅取整误差
    const est = mgr.estimateTokens(6);
    expect(Math.abs(bd.total - est)).toBeLessThanOrEqual(2);
    // 关键分类都应有值
    const byKey = Object.fromEntries(bd.categories.map((c) => [c.key, c.tokens]));
    expect(byKey.systemPrompt).toBeGreaterThan(0);
    expect(byKey.toolSchemas).toBeGreaterThan(0);
    expect(byKey.userText).toBeGreaterThan(0);
    expect(byKey.assistantText).toBeGreaterThan(0);
    expect(byKey.toolUse).toBeGreaterThan(0);
    expect(byKey.toolResult).toBeGreaterThan(0);
  });

  test("P0-2 getTokenBreakdown 汇总字段正确", () => {
    const mgr = new Manager({ maxTokens: 100_000 });
    mgr.addMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    const bd = mgr.getTokenBreakdown(0);
    expect(bd.maxTokens).toBe(100_000);
    // §12 复审：compactThresholdTokens 与真实触发链路同源（getCompactionThresholds），
    // 不再是 maxTokens×compactThreshold(0.7)。100K 窗口 hard 门槛 = max(60K, 18%)=60K → 触发点 40K。
    expect(bd.compactThresholdTokens).toBe(mgr.getCompactionThresholds().compactionTriggerUsed);
    expect(bd.compactThresholdTokens).toBe(40_000);
    expect(bd.calibrated).toBe(false);
    expect(mgr.isCalibrated()).toBe(false);
  });

  test("M4 isCalibrated 与 recordActualTokens 同步，O(1) 不走 breakdown", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    expect(mgr.isCalibrated()).toBe(false);
    mgr.addMessage({ role: "user", content: [{ type: "text", text: "x".repeat(1000) }] });
    mgr.recordActualTokens(800, 0);
    expect(mgr.isCalibrated()).toBe(true);
    expect(mgr.getTokenBreakdown(0).calibrated).toBe(true);
  });

  test("§12 复审：/context 展示的触发点 == getCompactionLevel 真实触发点（各窗口）", () => {
    // 历史 bug：1M 窗口 /context 显示 70%（maxTokens×0.7）而真实触发在 82%，少算 120K。
    for (const maxTokens of [100_000, 200_000, 1_000_000]) {
      const mgr = new Manager({ maxTokens });
      const trigger = mgr.getTokenBreakdown(0).compactThresholdTokens;
      // 恰好到触发点：应已进入 hard（或更紧急）
      mgr.setSystemPrompt("a".repeat(Math.ceil(trigger / 0.2)));
      expect(["hard", "emergency"]).toContain(mgr.getCompactionLevel(0));
      // 触发点前 10%：不应到 hard
      const mgr2 = new Manager({ maxTokens });
      mgr2.setSystemPrompt("a".repeat(Math.floor((trigger * 0.9) / 0.2)));
      expect(["none", "soft"]).toContain(mgr2.getCompactionLevel(0));
    }
  });

  test("§12 P3-2：完成缓冲区抬高 emergency 地板，且不让 200K 窗口回归（仍 70% 触发）", () => {
    // 200K 窗口 + 64K 输出：缓冲 = min(64K, 200K×12%)+20K = 24K+20K = 44K，
    // 但 hard 原门槛 60K > 44K → 缓冲不生效，触发点仍是 70%（零回归）。
    const std = new Manager({ maxTokens: 200_000, maxOutputTokens: 64_000 });
    expect(std.getTokenBreakdown(0).compactThresholdTokens).toBe(140_000);
    // 80K 窗口 + 超大输出：缓冲被 TOTAL_MAX_RATIO(20%) 封顶为 16K，不会吃掉过多窗口
    const big = new Manager({ maxTokens: 80_000, maxOutputTokens: 128_000 });
    const t = big.getCompactionThresholds();
    expect(t.completionBuffer).toBe(16_000);
    // 不变量：hard 永不晚于 emergency 触发
    expect(t.compressionRemaining).toBeGreaterThanOrEqual(t.emergencyRemaining);
    // 小窗口（≤60K）不启用缓冲区
    expect(new Manager({ maxTokens: 32_000 }).getCompactionThresholds().completionBuffer).toBe(0);
  });

  test("§12 复审：小窗口模型下 P1-1 override 同样生效（此前被静默忽略）", () => {
    // 32K 窗口设 50%：应在用量过半时进 hard，而非一直等到 90% 才 emergency
    const mgr = new Manager({ maxTokens: 32_000, compactThreshold: 0.5 });
    mgr.setSystemPrompt("a".repeat(Math.ceil(17_000 / 0.2))); // ~17K tokens > 16K
    expect(mgr.getCompactionLevel(0)).toBe("hard");
    // 未设 override 的小窗口：同样用量下不触发（保持原行为）
    const plain = new Manager({ maxTokens: 32_000 });
    plain.setSystemPrompt("a".repeat(Math.ceil(17_000 / 0.2)));
    expect(plain.getCompactionLevel(0)).toBe("none");
  });

  test("P0-2 getTokenBreakdown 空会话不崩溃", () => {
    const mgr = new Manager({ maxTokens: 100_000 });
    const bd = mgr.getTokenBreakdown(0);
    expect(bd.total).toBeGreaterThanOrEqual(0);
    expect(bd.categories.length).toBeGreaterThan(0);
  });
});

describe("P0-2 入队聚合预算", () => {
  test("一轮多个 bash 结果合计超 totalBudget 时在 addMessage 即截断", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    // 单体 < OUTPUT_THRESHOLD(30K) 不会落盘；8 × 29K 字符 ≈ 58K token > totalBudget 50K。
    const chunk = "x".repeat(29_000);
    mgr.addMessage({
      role: "assistant",
      content: Array.from({ length: 8 }, (_, i) => ({
        type: "tool_use" as const,
        id: `b${i}`,
        name: "bash",
        input: { command: `echo ${i}` },
      })),
    });
    mgr.addMessage({
      role: "user",
      content: Array.from({ length: 8 }, (_, i) => ({
        type: "tool_result" as const,
        tool_use_id: `b${i}`,
        content: chunk,
      })),
    });
    const results = mgr
      .getMessages()
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result");
    const truncated = results.filter(
      (b) => b.type === "tool_result" && String(b.content).includes("工具输出已截断"),
    );
    expect(truncated.length).toBeGreaterThan(0);
    const totalChars = results.reduce(
      (s, b) => s + (b.type === "tool_result" ? String(b.content).length : 0),
      0,
    );
    expect(totalChars).toBeLessThan(8 * 29_000);
  });

  test("read 工具结果不受入队聚合预算截断", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    mgr.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "r1", name: "read", input: { file_path: "/tmp/a.ts" } }],
    });
    const body = "y".repeat(40_000);
    mgr.addMessage({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "r1", content: body }],
    });
    const block = mgr.getMessages()[1].content[0];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.content).toBe(body);
      expect(block.content).not.toContain("工具输出已截断");
    }
  });
});

describe("P0-3 KEEP_RECENT 窗口前移不得改写已发送前缀", () => {
  test("第 1 个大输出完整发送后，第 7 个到来时仍保持原文", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    const bodies: string[] = [];
    for (let i = 0; i < 6; i++) {
      bodies.push("z".repeat(40_000) + String(i));
      mgr.addMessage({
        role: "assistant",
        content: [
          { type: "tool_use", id: `t${i}`, name: "read", input: { file_path: `/tmp/${i}.txt` } },
        ],
      });
      mgr.addMessage({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `t${i}`, content: bodies[i] }],
      });
    }
    const firstRound = mgr.getCleanedMessages();
    const firstContent = firstRound
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result" && b.tool_use_id === "t0");
    expect(firstContent?.type).toBe("tool_result");
    if (firstContent?.type === "tool_result") {
      expect(firstContent.content).toBe(bodies[0]);
    }

    mgr.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "t6", name: "read", input: { file_path: "/tmp/6.txt" } }],
    });
    mgr.addMessage({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t6", content: "z".repeat(40_000) + "6" }],
    });
    const secondRound = mgr.getCleanedMessages();
    const stillFirst = secondRound
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result" && b.tool_use_id === "t0");
    expect(stillFirst?.type).toBe("tool_result");
    if (stillFirst?.type === "tool_result") {
      expect(stillFirst.content).toBe(bodies[0]);
      expect(stillFirst.content).not.toContain("已清理");
    }
  });

  test("一次堆到 KEEP_RECENT 以上、从未发给 API 的旧输出仍可清理", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    for (let i = 0; i < 8; i++) {
      mgr.addMessage({
        role: "assistant",
        content: [
          { type: "tool_use", id: `u${i}`, name: "read", input: { file_path: `/tmp/${i}.txt` } },
        ],
      });
      mgr.addMessage({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `u${i}`, content: "w".repeat(40_000) }],
      });
    }
    const cleaned = mgr.getCleanedMessages();
    const first = cleaned
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result" && b.tool_use_id === "u0");
    expect(first?.type).toBe("tool_result");
    if (first?.type === "tool_result") {
      expect(String(first.content)).toContain("已清理");
    }
  });
});

describe("P0-5 压缩来源守卫接到 getCompactionLevel", () => {
  test("几乎只剩压缩产物时不再报 hard/emergency", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    mgr.setSystemPrompt("a".repeat(850_000));
    expect(mgr.getCompactionLevel()).toBe("emergency");
    mgr.addCompactBoundary("先前摘要", 40);
    mgr.addMessage({
      role: "assistant",
      content: [{ type: "text", text: "好的，我已了解之前的对话内容。请继续。" }],
      _meta: { origin: "compact-summary" },
    });
    expect(mgr.getCompactionLevel()).toBe("none");
  });

  test("压缩后再积累新对话，守卫放开", () => {
    const mgr = new Manager({ maxTokens: 200_000 });
    mgr.setSystemPrompt("a".repeat(850_000));
    mgr.addCompactBoundary("先前摘要", 40);
    for (let i = 0; i < 4; i++) {
      mgr.addMessage({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `新对话 ${i}` }],
      });
    }
    expect(mgr.getCompactionLevel()).toBe("emergency");
  });

  test("首次清理大输出后重复 getCleanedMessages 不再继续改写", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    for (let i = 0; i < 8; i++) {
      mgr.addMessage({
        role: "assistant",
        content: [
          { type: "tool_use", id: `c${i}`, name: "read", input: { file_path: `/tmp/${i}.txt` } },
        ],
      });
      mgr.addMessage({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `c${i}`, content: "q".repeat(40_000) }],
      });
    }
    const first = mgr.getCleanedMessages();
    const firstCleared = first
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result" && String(b.content).includes("已清理")).length;
    expect(firstCleared).toBeGreaterThan(0);
    const second = mgr.getCleanedMessages();
    const third = mgr.getCleanedMessages();
    const snapshot = (msgs: typeof first) =>
      msgs
        .flatMap((m) => m.content)
        .filter((b) => b.type === "tool_result")
        .map((b) => (b.type === "tool_result" ? `${b.tool_use_id}:${b.content}` : ""))
        .join("|");
    expect(snapshot(second)).toBe(snapshot(first));
    expect(snapshot(third)).toBe(snapshot(first));
  });
});
