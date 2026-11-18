/**
 * PR1 / C1：面板 total、footer used、分类合计三者必须**严格同源**。
 *
 * 事故形态（2026-11-17）：同一份上下文估算，三个出口三套算法——
 * - `getCompactionLevel`（决策）与 `getContextUsageForDisplay`（footer）已同源，
 * - 但 `getTokenBreakdown`（/context 面板）自己写了第 7 份手写 if/else 链：
 *   thinking / redacted_thinking / provider_reasoning 整类不认（长会话实测漏算 28k），
 *   各分类 `round(n × factor)` 后求和又与 footer 的 `ceil(raw × factor)` 差几到几十 token。
 *
 * 后果：面板说 92,412、状态栏说 92,873，两个数都自称是「已用」。
 * 而**没有任何一条断言把两者放在一起比** —— 现有断言全是自洽型的
 * （total = Σ分类、差值 = 差值），各自内部自洽，跨口径不一致永远测不出来。
 *
 * 本文件补的就是那个缺失的跨口径断言，并用**五个状态**覆盖所有取数分支。
 */

import { describe, test, expect } from "bun:test";
import { Manager } from "@sid-code/core/context/manager.ts";
import { estimateBlockTokens, estimateConversationTokens } from "@sid-code/core/context/token.ts";
import type { ContentBlock, Message } from "@sid-code/core/llm/types.ts";

/**
 * 全块类型样例表。
 *
 * `satisfies Record<ContentBlock["type"], ContentBlock>` 是本文件的第一道门禁：
 * `ContentBlock` 联合类型新增成员而本表没跟上时，**类型检查直接报错**——
 * 新块类型不可能再「静默漏算」（旧 if 链正是这种失败形态：没有 else，漏了也不报错）。
 *
 * 工具名刻意用 30+ 字符：工具名本身计入 token，用 `read` 这种短名会让
 * 「漏算工具名」的缺陷藏得住（漏 8 token 看不出异常）。
 */
const BLOCK_SAMPLES = {
  text: {
    type: "text",
    text: "这是一段用于估算的普通文本内容，包含中英文 mixed content 与标点符号。",
  },
  tool_use: {
    type: "tool_use",
    id: "toolu_01ABCDEFGHIJKLMN",
    name: "read_file_with_a_very_long_tool_name_v2",
    input: { file_path: "/tmp/example.ts", offset: 120, limit: 400 },
  },
  tool_result: {
    type: "tool_result",
    tool_use_id: "toolu_01ABCDEFGHIJKLMN",
    // > microcompact 的 500 字符候选阈值，才会进入过期清理候选
    content: "工具返回的内容行\n".repeat(80),
  },
  thinking: {
    type: "thinking",
    thinking: "先分析问题，再决定用哪个工具，最后核对结果是否自洽。".repeat(10),
    signature: "sig-abc-123",
  },
  redacted_thinking: {
    type: "redacted_thinking",
    data: "ENCRYPTED_PAYLOAD_".repeat(30),
  },
  provider_reasoning: {
    type: "provider_reasoning",
    protocol: "openai-responses",
    model: "gpt-5",
    item: { type: "reasoning", encrypted_content: "xyz" },
  },
} satisfies Record<ContentBlock["type"], ContentBlock>;

/**
 * 会话夹具：覆盖全部块类型 + 多轮 tool_result（清理路径需要「老的」结果作为候选）。
 * 顺序贴近真实会话：user 提问 → assistant 思考 + 调工具 → 工具结果 → ...
 *
 * ⚠️ 清理轮次必须用**白名单内的只读工具名**（`read`）：`planMicrocompact` 对未分类工具
 * （自定义 / MCP）采取「原样保留」的保守策略，用长名自定义工具造不出 freed > 0。
 * 长名工具由第一轮的 `BLOCK_SAMPLES.tool_use` 单独覆盖，两者职责不同，不合并。
 */
function conversation(): Message[] {
  const msgs: Message[] = [{ role: "user", content: [BLOCK_SAMPLES.text] }];
  msgs.push({
    role: "assistant",
    content: [
      BLOCK_SAMPLES.thinking,
      BLOCK_SAMPLES.redacted_thinking,
      BLOCK_SAMPLES.text,
      BLOCK_SAMPLES.tool_use,
    ],
  });
  for (let i = 0; i < 6; i++) {
    msgs.push({
      role: "user",
      content: [{ ...BLOCK_SAMPLES.tool_result, tool_use_id: `toolu_${i}` }],
    });
    msgs.push({
      role: "assistant",
      content: [
        BLOCK_SAMPLES.provider_reasoning,
        BLOCK_SAMPLES.text,
        { type: "tool_use", id: `toolu_${i}`, name: "read", input: { file_path: `/tmp/f${i}.ts` } },
      ],
    });
  }
  return msgs;
}

function freshManager(): { mgr: Manager; messages: Message[] } {
  const messages = conversation();
  const mgr = new Manager({ maxTokens: 1_000_000 });
  mgr.setMessages(messages);
  return { mgr, messages };
}

/**
 * 三条恒等式，**全部严格相等、不设容差**。
 *
 * 不设容差是刻意的：容差会随着改动慢慢变大（先 ±2，再 ±10），
 * 最后变成一个永远为真的断言。同源就该是逐字相等，做不到就是没同源。
 */
function assertSameSource(mgr: Manager): void {
  const bd = mgr.getTokenBreakdown(0);
  const usage = mgr.getContextUsageForDisplay(0);

  // ① 面板 total 与 footer used 是同一个表达式的返回值
  expect(bd.total).toBe(usage.used);

  // ② 分类合计 === 毛估算（最大余数法保证，不是「各自取整后碰巧相等」）
  expect(bd.categories.reduce((sum, c) => sum + c.tokens, 0)).toBe(bd.grossTokens);

  // ③ 总量 = 毛估算 + 锚点抬升 − 本地释放，钳零
  expect(bd.total).toBe(Math.max(0, bd.grossTokens + bd.anchorLiftTokens - bd.freed.tokens));

  // ④ freed 的按策略拆分必须自洽（否则 UI 展示的细目加起来对不上合计）
  expect(bd.freed.byStrategy.reduce((sum, x) => sum + x.tokens, 0)).toBe(bd.freed.tokens);

  // ⑤ level / percentOfTrigger 与 footer 同源
  expect(bd.level).toBe(usage.level);
  expect(bd.percentOfTrigger).toBe(usage.percentOfTrigger);
}

/**
 * 逐类断言：thinking 分类必须真的收到「thinking + redacted_thinking」两块的估算。
 *
 * 断言写成「精确值的 floor/ceil 区间」而不是文档里的「相差 < 1」：
 * 最大余数法保证每项只会是 `floor(exact)` 或 `ceil(exact)`，这是更强的判据；
 * 而「相差 < 1」在 `ceil(rawTotal × factor)` 引入额外零头时数学上并不总成立
 * （上界是 `1 + rawThinking/rawTotal`），写成 < 1 会变成一条偶发假红的门禁。
 */
function assertThinkingCategory(mgr: Manager, messages: Message[]): void {
  const bd = mgr.getTokenBreakdown(0);
  const thinking = bd.categories.find((c) => c.key === "thinking");
  expect(thinking).toBeDefined();
  expect(thinking!.tokens).toBeGreaterThan(0);

  // provider_reasoning 的 estimateBlockTokens 按 0 计（密文不进新采样），加上无影响
  const rawThinking =
    estimateBlockTokens(BLOCK_SAMPLES.thinking) +
    estimateBlockTokens(BLOCK_SAMPLES.redacted_thinking);
  expect(rawThinking).toBeGreaterThan(0);

  // 与 Manager 内部完全相同的入参：默认 systemPrompt "" / toolCount 0 / toolSchemaTokens null
  const rawTotal = estimateConversationTokens(messages, {});
  const exact = (rawThinking * bd.grossTokens) / rawTotal;
  expect(thinking!.tokens).toBeGreaterThanOrEqual(Math.floor(exact));
  expect(thinking!.tokens).toBeLessThanOrEqual(Math.ceil(exact));

  // 未校准时 grossTokens === rawTotal，每个分类都应严格等于自己的原始估算
  if (!bd.calibrated) {
    expect(thinking!.tokens).toBe(rawThinking);
  }
}

describe("PR1 访问者契约：Σ 上报量 === 返回值", () => {
  /**
   * 这条断言测的是 `estimateConversationTokens` 自己的契约，而不是 Manager 的分配结果。
   *
   * 为什么必须单独测：`Σ categories === grossTokens` 由 `allocateByWeight` 的构造**恒等保证**
   * （它按比例把 grossTokens 分完），所以「访问者漏报一段 token」这种变异它抓不到——
   * 权重少一点，分配结果仍严格等于 grossTokens，只是比例悄悄错了。
   * 真正能抓住漏报的，是「上报量之和 === 函数返回值」这条更底层的恒等式。
   */
  test("system / tools / overhead / 各内容块（含 tool_use +20、tool_result +10）全部被上报", () => {
    const messages = conversation();
    let visited = 0;
    const total = estimateConversationTokens(messages, {
      systemPrompt: "系统提示词示例".repeat(20),
      toolCount: 6,
      visit: (_part, tokens) => {
        visited += tokens;
      },
    });

    expect(visited).toBe(total);
    // 反向确认这条夹具真的覆盖到了结构开销（否则「漏掉 +20」类变异测不出来）
    expect(total).toBeGreaterThan(estimateConversationTokens(messages, {}));
  });
});

describe("PR1 跨口径一致性：面板 total 与 footer used 严格同源", () => {
  test("状态 1：未校准（纯启发式）", () => {
    const { mgr, messages } = freshManager();

    const bd = mgr.getTokenBreakdown(0);
    expect(bd.calibrated).toBe(false);
    expect(bd.anchorLiftTokens).toBe(0); // 未校准没有锚点
    expect(bd.freed.tokens).toBe(0);

    assertSameSource(mgr);
    assertThinkingCategory(mgr, messages);
  });

  test("状态 2：已校准、锚点未抬升（ratio = 1 时因子为 1，C 与锚点相等）", () => {
    const { mgr, messages } = freshManager();
    const raw = mgr.estimateTokens(0);
    mgr.recordActualTokens(raw, 0);

    const bd = mgr.getTokenBreakdown(0);
    expect(bd.calibrated).toBe(true);
    // 前提：这一档刻意造「没有抬升」，用来区分「校准」与「锚点抬升」两个效果
    expect(bd.anchorLiftTokens).toBe(0);

    assertSameSource(mgr);
    assertThinkingCategory(mgr, messages);
  });

  test("状态 3：已校准、锚点抬升（连续两次 usage，因子 1.15 → 1.5，EMA 后 1.255）", () => {
    const { mgr, messages } = freshManager();
    const raw = mgr.estimateTokens(0);
    // 只调一次造不出抬升：首次校准 factor 就等于真实值÷估算值，C 与锚点几乎相等。
    // 两次才让 EMA 后的 factor（1.255）明显低于第二个比值（1.5），锚点才会高于 C。
    mgr.recordActualTokens(Math.round(raw * 1.15), 0);
    mgr.recordActualTokens(Math.round(raw * 1.5), 0);

    const bd = mgr.getTokenBreakdown(0);
    expect(bd.calibrated).toBe(true);
    // 前提：抬升必须真的发生，否则本状态与状态 2 等价、覆盖不到 max(C, 锚点) 分支
    expect(bd.anchorLiftTokens).toBeGreaterThan(0);

    assertSameSource(mgr);
    assertThinkingCategory(mgr, messages);
  });

  test("状态 4：过期清理之后（freed > 0，分类合计已扣减前口径）", () => {
    const { mgr, messages } = freshManager();
    const r = mgr.applyColdCacheClear();
    // 前提：确实发生了清理，否则覆盖不到 sendTokensFrom 的减项分支
    expect(r.cleared).toBeGreaterThan(0);
    expect(r.savedChars).toBeGreaterThan(0);

    const bd = mgr.getTokenBreakdown(0);
    expect(bd.freed.tokens).toBeGreaterThan(0);
    expect(bd.freed.byStrategy.some((x) => x.strategy === "coldCacheClear")).toBe(true);

    assertSameSource(mgr);
    assertThinkingCategory(mgr, messages);
  });

  test("状态 5：压缩重置之后（锚点与 freed 一起清零，total 回落到毛估算）", () => {
    const { mgr, messages } = freshManager();
    const raw = mgr.estimateTokens(0);
    mgr.recordActualTokens(Math.round(raw * 1.5), 0);
    mgr.applyColdCacheClear();
    expect(mgr.getTokenBreakdown(0).freed.tokens).toBeGreaterThan(0); // 前提：先有欠账

    // setMessages 与压缩 / 截断共用 resetLocalCompactState（见 manager.ts 注释），
    // 重置语义相同：锚点失效 + freed 清零。
    mgr.setMessages(conversation());

    const bd = mgr.getTokenBreakdown(0);
    expect(bd.anchorLiftTokens).toBe(0);
    expect(bd.freed.tokens).toBe(0);
    expect(bd.total).toBe(bd.grossTokens);

    assertSameSource(mgr);
    assertThinkingCategory(mgr, messages);
  });
});
