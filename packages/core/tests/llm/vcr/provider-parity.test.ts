/**
 * 跨 provider parity 断言 — provider-parity.test.ts（PR-1）
 *
 * § 这个文件存在的唯一理由
 * PR-2/PR-3 要把 **199 处族判定**（`deepseek` 83 / `glm` 49 / `grok` 30 / `qwen` 15 /
 * `kimi` 12 / `gemini` 10，散在 `packages/core/src/llm` 的 15 个文件里）从代码分支
 * 收敛成数据（compat 布尔位 + dialect 模块）。**没有回归网，那次重构就是裸奔**——
 * 单个 provider 的单测能证明「openai 还能跑」，但证明不了「三族在同一语义场景下**行为仍然一致**」。
 *
 * § parity 的正确比对面
 * **不是**逐一比对 StreamEvent 序列——三族的事件形状刻意不同（usage 时机、thinking 载体、
 * 有无 `[DONE]` 哨兵），逐一比对只会把协议差异当缺陷报出来。比对面是**下游真正消费的那层**：
 * 文本 / 思考文本 / 工具调用 / 归一化 `stopReason` / 经 `accumulateUsage` 累加后的 usage。
 * 归一化实现在 `replay-collect.ts`（三族共用一份，不写第二份）。
 *
 * § 断言的分层
 * 1. **PARITY-N**：同一语义场景在多族之间必须等价 —— 这是 PR-2/PR-3 的回归网本体。
 * 2. **协议专属**：只在某一族成立的行为（Anthropic 的 signature_delta、DeepSeek 的
 *    insufficient_system_resource 等），单族断言，不进 parity。
 *
 * § 建这张网时查出并修掉的四个缺陷
 * 四条都是**从字节层回放**才暴露的 —— 此前的 provider 测试都在 Provider 层造假流
 * （直接 yield 已经成形的 StreamEvent），绕过了真实的解析/SDK 路径。也就是说它们测的是
 * 「下游拿到字段后处理得对不对」，而不是「provider 到底给不给得出那些字段」。
 *
 *   - **A**：`content_part.added` 的推理判据用了规范里不存在的 part 类型 `"reasoning"`
 *     （规范是 `reasoning_text`），且真实流走的 `reasoning_summary_part.added`
 *     根本没有对应 case → Responses 族推理摘要串进正文。
 *   - **A′**：修 A 时 TypeScript 收窄 union 报 "no overlap"，连带暴露**非流式路径**
 *     写了同一个错字面量 → 非流式思考内容同样被丢弃。**这条是类型检查查出来的，
 *     不是 review 看出来的** —— 也是为什么值得把字面量收进一个 union 而不是散写字符串。
 *   - **B**：`response.incomplete` 不采 usage（同为终态的 `completed` 采了）
 *     → 截断轮成本记 0，而截断轮恰是单轮最贵的那类。
 *   - **C**：Anthropic SDK 对 `event: error` 直接 throw、从不 yield，导致
 *     `case "error"` 不可达，catch 只取 `err.message` → 结构化 `type`/`streamLevel` 丢失。
 *
 * 四条均已在本轮修复，断言从「`test.failing` 钉桩」转为「防复发断言」，
 * 分别落在下面的 "防复发 · …" 两节与「协议专属 · Anthropic」节。
 */

import { describe, test, expect } from "bun:test";
import { classifyError, classifyStreamError, StreamLevelError } from "@sid-code/core/llm/errors.ts";
import { parseResponsesBody } from "@sid-code/core/llm/openai-responses.ts";
import { replayFixture, type ProtocolFamily, type ReplayResult } from "./replay-collect.ts";

/** 一个语义场景在某一族里的夹具坐标 */
interface Case {
  family: ProtocolFamily;
  fixture: string;
  label: string;
}

/** 回放一组 case，返回 label → 结果 */
async function replayAll(cases: Case[]): Promise<Map<string, ReplayResult>> {
  const out = new Map<string, ReplayResult>();
  for (const c of cases) {
    out.set(c.label, await replayFixture(c.fixture, c.family));
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// PARITY-1 · 纯文本流：三族的正文文本必须完全一致
// ══════════════════════════════════════════════════════════════════════════

describe("PARITY-1 纯文本流", () => {
  test("三族回放同一句正文，text 完全一致且无 error", async () => {
    // 三份夹具的正文刻意都写成同一句，这样「一致」是可断言的常量而不是互相比较的空话。
    const results = await replayAll([
      { family: "anthropic-messages", fixture: "anthropic-normal-stream.json", label: "anthropic" },
      { family: "openai-chat", fixture: "openai-normal-stream.json", label: "openai-chat" },
    ]);

    for (const [label, r] of results) {
      expect(r.text, `${label} 的正文`).toBe("Hello, world!");
      expect(r.errorMessage, `${label} 不应有 error`).toBeNull();
      expect(r.thinking, `${label} 无思考内容`).toBe("");
      expect(r.stopReason, `${label} 正常收尾`).toBe("end_turn");
    }
  });

  test("Responses 族正常文本流同样落 end_turn 且无 error", async () => {
    // responses-normal-text 夹具的正文是 "Hello there!"（早于本 PR 入库，不改它的内容——
    // 夹具是资产，改已入库夹具会让它不再是"录到的那次真实响应"）。
    const r = await replayFixture("responses-normal-text.json", "openai-responses");
    expect(r.text).toBe("Hello there!");
    expect(r.stopReason).toBe("end_turn");
    expect(r.errorMessage).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PARITY-2 · 单工具调用：三族的 name 与参数 JSON 必须一致
// ══════════════════════════════════════════════════════════════════════════

describe("PARITY-2 单工具调用", () => {
  test("三族回放同一个 get_weather 调用，name 与参数 JSON 一致", async () => {
    const results = await replayAll([
      {
        family: "anthropic-messages",
        fixture: "anthropic-tool-call-stream.json",
        label: "anthropic",
      },
      { family: "openai-chat", fixture: "openai-tool-call-stream.json", label: "openai-chat" },
    ]);

    for (const [label, r] of results) {
      expect(r.toolCalls.length, `${label} 应恰好一个工具调用`).toBe(1);
      expect(r.toolCalls[0]!.name, `${label} 的工具名`).toBe("get_weather");
      // 比对**解析后的对象**而不是字符串：分片拼接的字符串可能键序不同，
      // 但语义必须相同。这是 parity 该管的层次。
      expect(JSON.parse(r.toolCalls[0]!.argsJson), `${label} 的参数`).toEqual({ city: "Paris" });
      expect(r.errorMessage, `${label} 不应有 error`).toBeNull();
    }
  });

  test("工具调用轮的正文为空不代表流失败（纯 tool_use 轮）", async () => {
    // 这条钉住一个真实踩过的形态：只有 tool_use、没有任何可视文本的轮，
    // 曾让"只在可视文本上计 TTFT"的口径系统性虚高数十秒。
    const r = await replayFixture("anthropic-tool-call-stream.json", "anthropic-messages");
    expect(r.text).toBe("");
    expect(r.toolCalls.length).toBe(1);
    expect(r.stopReason).toBe("tool_use");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PARITY-3 · 多工具并行：三族的调用顺序与参数必须一致
// ══════════════════════════════════════════════════════════════════════════

describe("PARITY-3 多工具并行", () => {
  test("三族回放两个并行工具，顺序与参数完全一致", async () => {
    const results = await replayAll([
      {
        family: "anthropic-messages",
        fixture: "anthropic-parallel-tools.json",
        label: "anthropic",
      },
      { family: "openai-chat", fixture: "openai-parallel-tools.json", label: "openai-chat" },
      {
        family: "openai-responses",
        fixture: "responses-parallel-tools.json",
        label: "openai-responses",
      },
    ]);

    for (const [label, r] of results) {
      expect(r.toolCalls.length, `${label} 应有两个工具调用`).toBe(2);
      expect(
        r.toolCalls.map((t) => t.name),
        `${label} 的调用顺序`,
      ).toEqual(["get_weather", "get_time"]);
      expect(JSON.parse(r.toolCalls[0]!.argsJson), `${label} 第一个参数`).toEqual({
        city: "Paris",
      });
      expect(JSON.parse(r.toolCalls[1]!.argsJson), `${label} 第二个参数`).toEqual({ tz: "UTC" });
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PARITY-4 · 截断：三族的 max_tokens 都必须归一到同一个 stopReason
// ══════════════════════════════════════════════════════════════════════════

describe("PARITY-4 截断归一", () => {
  test("三族的截断（stop_reason=max_tokens / finish_reason=length / response.incomplete）都归一为 max_tokens", async () => {
    // 这条是三族**线格式完全不同、语义完全相同**的典型：
    //   Anthropic: message_delta.stop_reason = "max_tokens"
    //   OpenAI Chat: finish_reason = "length"  → mapFinishReason → "max_tokens"
    //   Responses: response.incomplete        → 映射 → "max_tokens"
    // 归一化如果哪天被改坏，上层「输出被截断要不要续写」的判断会同时对三族失效。
    const results = await replayAll([
      {
        family: "anthropic-messages",
        fixture: "anthropic-max-tokens-truncated.json",
        label: "anthropic",
      },
      {
        family: "openai-chat",
        fixture: "openai-max-tokens-truncated.json",
        label: "openai-chat",
      },
      {
        family: "openai-responses",
        fixture: "responses-incomplete.json",
        label: "openai-responses",
      },
    ]);

    for (const [label, r] of results) {
      expect(r.stopReason, `${label} 的截断 stopReason`).toBe("max_tokens");
      expect(r.text, `${label} 的截断正文`).toBe("This answer gets cut off mid-");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PARITY-5 · usage：不同下发时机，累加后必须落到同一口径
// ══════════════════════════════════════════════════════════════════════════

describe("PARITY-5 usage 口径", () => {
  test("Anthropic（message_start 全量 + message_delta 增量）与 OpenAI（尾部全量）累加后同口径", async () => {
    // 两族 usage 的**下发时机与语义都不同**（见 replay-collect.ts 文件头），
    // 唯一可比的是 accumulateUsage 之后的值。夹具刻意让两族的 in/out 相同。
    const an = await replayFixture("anthropic-max-tokens-truncated.json", "anthropic-messages");
    const oa = await replayFixture("openai-max-tokens-truncated.json", "openai-chat");

    expect(an.usage.inputTokens).toBe(8);
    expect(an.usage.outputTokens).toBe(10);
    expect(oa.usage.inputTokens).toBe(8);
    expect(oa.usage.outputTokens).toBe(10);
    // parity 本体：累加后两族必须相等
    expect(oa.usage.inputTokens).toBe(an.usage.inputTokens);
    expect(oa.usage.outputTokens).toBe(an.usage.outputTokens);
  });

  test("Anthropic 的 output_tokens 是累积值，转增量后不重复计种子", async () => {
    // message_start 给 output_tokens=0、message_delta 给累积值 5。
    // 若哪天误把累积值当增量直接累加，这里会变成 0+5+5=10。
    const r = await replayFixture("anthropic-normal-stream.json", "anthropic-messages");
    expect(r.usage.outputTokens).toBe(5);
    expect(r.usage.inputTokens).toBe(12);
  });

  test("三种 cache 命中字段形态都能被采到（这是 2026-08-08 漏采整族的防复发点）", async () => {
    // 三个不同的键名，同一个语义。extractOpenAICacheHit 的兜底链断任意一环，
    // 都会让对应族的命中率静默归零——而账本依然"有数"，只是数是错的。
    const cases: Array<[string, ProtocolFamily, number, string]> = [
      // ① prompt_tokens_details.cached_tokens —— OpenAI Chat 标准字段
      ["openai-usage-tail.json", "openai-chat", 64, "prompt_tokens_details.cached_tokens"],
      // ② prompt_cache_hit_tokens —— DeepSeek 官方直连顶层专有字段
      ["deepseek-reasoning-cache.json", "openai-chat", 32, "prompt_cache_hit_tokens"],
      // ③ input_tokens_details.cached_tokens —— Responses 族形态（曾漏采整族 11 个模型）
      ["responses-reasoning.json", "openai-responses", 32, "input_tokens_details.cached_tokens"],
    ];
    for (const [fixture, family, expected, field] of cases) {
      const r = await replayFixture(fixture, family);
      expect(r.usage.cacheReadInputTokens, `${fixture} 的 ${field}`).toBe(expected);
    }
  });

  test("Anthropic 的 cache 字段走另一套键名，同样落进归一化 usage", async () => {
    const r = await replayFixture("anthropic-cache-hit.json", "anthropic-messages");
    expect(r.usage.cacheReadInputTokens).toBe(2048);
    expect(r.usage.cacheCreationInputTokens).toBe(0);
  });

  test("reasoning token 在两族都单独计，且不叠加进 outputTokens", async () => {
    // reasoning 是 output 的**子集**。若某天有人"顺手"把它加进 outputTokens，
    // 成本统计会对所有思考模型系统性虚高。
    const oa = await replayFixture("deepseek-reasoning-cache.json", "openai-chat");
    expect(oa.usage.reasoningTokens).toBe(12);
    expect(oa.usage.outputTokens).toBe(20); // 不是 20+12

    const rs = await replayFixture("responses-reasoning.json", "openai-responses");
    expect(rs.usage.reasoningTokens).toBe(12);
    expect(rs.usage.outputTokens).toBe(20);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PARITY-6 · 流内 error：三族都必须产出 error 事件而不是静默截断
// ══════════════════════════════════════════════════════════════════════════

describe("PARITY-6 流内 error", () => {
  test("三族的流内错误都产出 error 事件（不静默结束）", async () => {
    // 「静默结束」是最坏的失败形态：上层拿到一个看起来正常收尾的短回答，
    // 既不重试也不报错。三族必须都有 error 事件。
    const results = await replayAll([
      { family: "anthropic-messages", fixture: "anthropic-stream-error.json", label: "anthropic" },
      { family: "openai-chat", fixture: "openai-stream-error.json", label: "openai-chat" },
      { family: "openai-responses", fixture: "responses-failed.json", label: "openai-responses" },
    ]);

    for (const [label, r] of results) {
      expect(r.errorMessage, `${label} 必须有 error 事件`).not.toBeNull();
      // 错误轮不该给出正常的 end_turn —— 那会让上层误判为成功收尾
      expect(r.stopReason, `${label} 错误轮不应是 end_turn`).not.toBe("end_turn");
    }
  });

  test("错误发生前已产出的部分文本要保留（供上层决定是否续写）", async () => {
    for (const [fixture, family] of [
      ["anthropic-stream-error.json", "anthropic-messages"],
      ["openai-stream-error.json", "openai-chat"],
    ] as Array<[string, ProtocolFamily]>) {
      const r = await replayFixture(fixture, family);
      expect(r.text, `${fixture} 的部分文本`).toBe("partial");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 协议专属断言（不进 parity —— 这些行为只在单族成立）
// ══════════════════════════════════════════════════════════════════════════

describe("协议专属 · Anthropic", () => {
  test("thinking 与正文分离，且 signature_delta 不污染任何文本", async () => {
    // signature 是多轮回传必需的字段（丢失/修改 → 400），但它**不是文本**。
    // 若哪天 signature_delta 被误当 text 累加，思考内容里会混进一串签名。
    const r = await replayFixture("anthropic-thinking-stream.json", "anthropic-messages");
    expect(r.thinking).toBe("Let me think about 6×7. It is 42.");
    expect(r.text).toBe("42");
    expect(r.thinking).not.toContain("sig_fixture");
    expect(r.text).not.toContain("sig_fixture");
  });

  test("ping 事件不产出任何内容（只有 keep-alive 的流不应被当作有进展）", async () => {
    // 这条对上「content-progress 谓词」这个我们相对领先的能力：ping 不算内容进展。
    // 断言的是解析结果——3 个 ping 一个字都不该进文本。
    const r = await replayFixture("anthropic-ping-only-then-content.json", "anthropic-messages");
    expect(r.text).toBe("finally");
    expect(r.errorMessage).toBeNull();
    expect(r.stopReason).toBe("end_turn");
  });

  /**
   * 流内 error 走的是 **SDK throw → provider catch** 这条路，不是 `case "error"`
   * （SDK `core/streaming.js` 对 `sse.event === 'error'` 直接 throw，从不 yield）。
   * 缺陷 C 修复后，catch 会从 `APIError.error`（SDK 保留的已解析 body）还原结构化字段。
   *
   * 这条断言的价值在于**它测的是真实路径**：现有的
   * `stream-level-error.test.ts` 在 Provider 层造假流、直接 yield 一个已带
   * `type`/`streamLevel` 的事件，绕过了整个 SDK —— 所以它证明不了 provider
   * 到底给不给得出这些字段。只有从字节层回放才能。
   */
  test("流内 error 还原上游结构化 type + streamLevel（供按字段而非关键词判重试）", async () => {
    const r = await replayFixture("anthropic-stream-error.json", "anthropic-messages");
    const errEvent = r.events.find((e) => e.type === "error") as any;
    expect(errEvent).toBeDefined();
    expect(errEvent.error?.type).toBe("overloaded_error");
    // streamLevel 是 fallback.ts 选 classifyStreamError（而非 classifyError）的开关
    expect(errEvent.error?.streamLevel).toBe(true);
    // 消息取上游的人类可读文本，而不是 SDK 拼的整串 body JSON
    expect(errEvent.error?.message).toBe("Overloaded");
  });

  test("还原出的结构化 type 确实让 fallback 判成可重试（端到端到分类器）", async () => {
    // 光断言"字段还原了"不够——要证明它真的改变了分类结果。
    // 关键点：这里刻意用**不含任何关键词**的场景才有意义，但本夹具消息是
    // "Overloaded"（含关键词），所以直接拿分类器对比两种输入：
    //   带 type   → StreamLevelError(可重试)
    //   不带 type → classifyError 靠关键词，无关键词时退化成裸 Error
    const r = await replayFixture("anthropic-stream-error.json", "anthropic-messages");
    const errEvent = r.events.find((e) => e.type === "error") as any;
    const classified = classifyStreamError(
      "anthropic",
      errEvent.error.message,
      errEvent.error.type,
      errEvent.error.statusCode,
    );
    expect(classified).toBeInstanceOf(StreamLevelError);
    expect((classified as any).reason).toBe("overloaded");

    // 反例：同样的消息文本但**没有关键词**时，丢了 type 就分不出可重试。
    // 这正是缺陷 C 在 api_error 类错误上的真实后果。
    const withoutType = classifyError(new Error("服务暂时不可用"));
    expect(withoutType).not.toBeInstanceOf(StreamLevelError);
    const withType = classifyStreamError("anthropic", "服务暂时不可用", "api_error");
    expect(withType).toBeInstanceOf(StreamLevelError);
  });
});

describe("协议专属 · OpenAI 族 finish_reason 映射", () => {
  test("content_filter 保留原值，不被误并入 end_turn", async () => {
    // 并入 end_turn 会掩盖内容审查：上层看到"正常收尾"，用户看到答案被吞。
    const r = await replayFixture("openai-content-filter.json", "openai-chat");
    expect(r.stopReason).toBe("content_filter");
  });

  test("DeepSeek insufficient_system_resource 走 error 事件（可重试路径）", async () => {
    // 这是 DeepSeek 特有的 finish_reason。实测 provider 把它转成 error 事件
    // 而不是 stopReason —— 因为上层要靠它触发 fallback 重试链，
    // 落成 stopReason 会被当作正常终态而不重试。
    const r = await replayFixture("deepseek-insufficient-resource.json", "openai-chat");
    expect(r.errorMessage).toContain("insufficient_system_resource");
    expect(r.stopReason).not.toBe("end_turn");
    // 错误前的部分文本仍保留
    expect(r.text).toBe("start");
  });

  test("DeepSeek reasoning_content 作为思考透传，不混入正文", async () => {
    const r = await replayFixture("deepseek-reasoning-cache.json", "openai-chat");
    expect(r.thinking).toBe("Thinking: 6*7 = 42");
    expect(r.text).toBe("42");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// § 缺陷防复发（三条都由本 PR 的字节层回放发现并当场修掉）
// ══════════════════════════════════════════════════════════════════════════

describe("防复发 · Responses 族推理摘要归属（缺陷 A）", () => {
  /**
   * 缺陷 A（已修）：`openai-responses.ts` 用 `part?.type === "reasoning"` 判定推理块，
   * 但 OpenAI 规范里 `content_part.added` 的 part 类型只有三种：
   * `output_text` / `refusal` / **`reasoning_text`**（openapi.yaml:54571-54575，
   * `ReasoningTextContent.type` 枚举值为 `reasoning_text`，openapi.yaml:75568-75574）。
   * **`"reasoning"` 这个值在规范里不存在**，所以该分支恒不命中。
   *
   * 更关键的是：真实流里推理摘要根本不走 `content_part.added`，而走
   * `response.reasoning_summary_part.added`（openapi.yaml:68718-68768），
   * 而解析器**完全没有这个 case** → `inReasoningBlock` 永不置位 →
   * 后续 `reasoning_summary_text.delta` 被当作**正文** text_delta 发出。
   * 修复前实测回放出 `text="Considering 6*742"`（摘要与正文粘连），`thinking` 为空。
   *
   * 修法：补 `reasoning_summary_part.added` case + 把字面量改成 `reasoning_text`，
   * 两处共用 `openThinkingBlock()`（幂等，防同一 item 多次 summary_index 重复开块）。
   *
   * ⚠️ 连带修了**非流式路径的同一个 bug**：`buildResponsesMessage` 里也写了
   * `part.type === "reasoning"`，即非流式思考内容同样被丢弃。这处是 TypeScript
   * 类型检查在收窄 union 后报 "no overlap" 才暴露的 —— 手工 review 没看出来。
   */
  test("推理摘要进 thinking、不污染正文（reasoning_summary_part.added 路径）", async () => {
    const r = await replayFixture("responses-reasoning.json", "openai-responses");
    expect(r.thinking).toBe("Considering 6*7");
    expect(r.text).toBe("42");
  });

  test("三族的思考内容都与正文分离（parity：这曾是唯一不一致的一族）", async () => {
    // 缺陷 A 的本质是 parity 缺口：Anthropic / DeepSeek 都分离，只有 Responses 不分离。
    // 这条断言把三族拉到一起，防止将来只修一族。
    const cases: Array<[string, ProtocolFamily, string, string]> = [
      [
        "anthropic-thinking-stream.json",
        "anthropic-messages",
        "Let me think about 6×7. It is 42.",
        "42",
      ],
      ["deepseek-reasoning-cache.json", "openai-chat", "Thinking: 6*7 = 42", "42"],
      ["responses-reasoning.json", "openai-responses", "Considering 6*7", "42"],
    ];
    for (const [fixture, family, thinking, text] of cases) {
      const r = await replayFixture(fixture, family);
      expect(r.thinking, `${fixture} 的思考`).toBe(thinking);
      expect(r.text, `${fixture} 的正文`).toBe(text);
    }
  });

  /**
   * 缺陷 A′：`parseResponsesBody`（非流式路径）里也写了同一个错字面量 `"reasoning"`，
   * 即降级到非流式时思考内容同样被丢弃。
   *
   * 这条**不是 review 看出来的** —— 是修 A 时把 `ContentPart.type` 收成 union 后，
   * TypeScript 报 "This comparison appears to be unintentional... have no overlap"
   * 才暴露的。教训：协议字面量散写成裸字符串时，写错了类型系统一声不响；
   * 收进一个 union，同类错误就变成编译期错误。
   *
   * 顺带补上：`parseResponsesBody` 此前**零测试覆盖**（全仓 grep 无引用），
   * 这正是它能带着 bug 存活的原因。降级路径的代码最容易这样——不常走，所以不常测。
   */
  test("非流式路径（降级用）同样把 reasoning_text 归到 thinking", () => {
    const parsed = parseResponsesBody({
      id: "resp_ns",
      status: "completed",
      output: [
        {
          id: "item_m",
          type: "message",
          role: "assistant",
          content: [
            { type: "reasoning_text", text: "Considering 6*7" },
            { type: "output_text", text: "42" },
          ],
        },
      ],
      usage: { input_tokens: 50, output_tokens: 20 },
    });

    expect(parsed.content).toEqual([
      { type: "thinking", thinking: "Considering 6*7" },
      { type: "text", text: "42" },
    ]);
    expect(parsed.stopReason).toBe("end_turn");
    expect(parsed.usage.inputTokens).toBe(50);
    expect(parsed.usage.outputTokens).toBe(20);
  });

  test("非流式 reasoning item 的 summary 也归到 thinking（另一种承载形态）", () => {
    // Responses 非流式有两种思考载体：message 里的 reasoning_text part，
    // 以及独立的 reasoning item 的 summary 数组。两条都要走通。
    const parsed = parseResponsesBody({
      id: "resp_ns2",
      status: "completed",
      output: [
        { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "step one" }] },
        {
          id: "item_m",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    expect(parsed.content).toEqual([
      { type: "thinking", thinking: "step one" },
      { type: "text", text: "done" },
    ]);
  });
});

describe("防复发 · Responses 族 incomplete 采 usage（缺陷 B）", () => {
  /**
   * 缺陷 B（已修）：`response.incomplete` 分支**不读 `response.usage`**，
   * 而同为终态的 `response.completed` 分支读了（调 `applyResponsesUsage`）。
   *
   * 规范上 `response.incomplete` 的 `response` 字段是完整的 `Response` 对象
   * （openapi.yaml:67965-67966），含 usage —— 所以漏读纯属遗漏而非协议限制。
   * 修复前实测回放出 `usage={inputTokens:0, outputTokens:0}`，而夹具里写了 8/10。
   *
   * 后果不是"少一个字段"，而是**方向性偏在最贵的样本上**：incomplete 意味着输出
   * 打到 max_tokens 上限，恰是单轮 output 最满、成本最高的那一类，而它的成本被记成 0。
   * 账本里越贵的轮越不计数 → 「更省」的曲线系统性偏乐观。
   */
  test("response.incomplete 采 usage（截断轮成本不记 0）", async () => {
    const r = await replayFixture("responses-incomplete.json", "openai-responses");
    expect(r.usage.inputTokens).toBe(8);
    expect(r.usage.outputTokens).toBe(10);
  });

  test("三族的截断轮 usage 都不为 0（parity：这曾是唯一记 0 的一族）", async () => {
    // 与 PARITY-4 互补：那条比 stopReason 归一，这条比"截断轮到底有没有成本"。
    // 缺陷 B 的形态正是「stopReason 对了但 usage 丢了」—— 只比前者会漏掉它。
    const cases: Array<[string, ProtocolFamily]> = [
      ["anthropic-max-tokens-truncated.json", "anthropic-messages"],
      ["openai-max-tokens-truncated.json", "openai-chat"],
      ["responses-incomplete.json", "openai-responses"],
    ];
    for (const [fixture, family] of cases) {
      const r = await replayFixture(fixture, family);
      expect(r.usage.inputTokens, `${fixture} 的 input`).toBe(8);
      expect(r.usage.outputTokens, `${fixture} 的 output`).toBe(10);
    }
  });
});

// 缺陷 C 的断言不单列一节 —— 它已并入上面「协议专属 · Anthropic」，
// 与 ping / thinking 等同族行为放在一起（那才是它的归属）。
