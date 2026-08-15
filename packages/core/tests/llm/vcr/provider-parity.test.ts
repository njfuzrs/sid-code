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
 * § 已知不 parity 的三处（本文件用 `test.failing` 钉住，不是遗漏）
 * 见文件末尾 "§ 已知缺陷" 两节，三条都是本 PR 从字节层回放才暴露出来的：
 *   - **缺陷 A**：`response.content_part.added` 的 reasoning 判据用了规范里不存在的
 *     part 类型 → Responses 族推理摘要串进正文（证据：openapi.yaml 行号）。
 *   - **缺陷 B**：`response.incomplete` 不采 usage → 截断轮成本记 0（同上）。
 *   - **缺陷 C**：Anthropic SDK 对 `event: error` 直接 throw，`case "error"` 不可达
 *     → 结构化 `error.type` / `streamLevel` 丢失（证据：SDK 源码行号）。
 *
 * **用 `test.failing` 而不是注释掉**：注释掉的断言不会在修好之后提醒你回来删，
 * `test.failing` 会在缺陷被修复的那一刻变红（此机制已实测自证：断言一旦通过，
 * bun 报 "marked as failing but it passed"）。
 *
 * 三条都**不在本 PR 修** —— PR-1 的范围是「补回归网」，改 provider 行为属 fix 类改动，
 * 应各自单开 PR。这三条 test.failing 就是那些 PR 的现成验收断言。
 */

import { describe, test, expect } from "bun:test";
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
   * 这条断言钉住的是**实际行为**，不是期望行为——期望行为见下面缺陷 C 的 test.failing。
   *
   * 实测：`event: error` 到不了 `anthropic.ts:634` 的 `case "error"`。Anthropic SDK 在
   * `core/streaming.js:62-63` 对 `sse.event === 'error'` **直接 throw APIError**，
   * 根本不 yield 该事件。所以真实 SDK 路径走的是 `anthropic.ts:668` 的 catch，
   * 那里只取 `err.message`（整个 body 的 JSON 字符串），`type` / `streamLevel` 全丢。
   */
  test("流内 error 目前经 SDK throw → catch 落地，结构化字段丢失（现状钉桩）", async () => {
    const r = await replayFixture("anthropic-stream-error.json", "anthropic-messages");
    const errEvent = r.events.find((e) => e.type === "error") as any;
    expect(errEvent).toBeDefined();
    // 现状：message 里是被 JSON.stringify 的整个 error body
    expect(errEvent.error?.message).toContain("overloaded_error");
    // 现状：结构化字段没了（这正是缺陷 C）
    expect(errEvent.error?.type).toBeUndefined();
    expect(errEvent.error?.streamLevel).toBeUndefined();
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
// § 已知缺陷（用 test.failing 钉住，修好后会变红提醒删除 .failing）
// ══════════════════════════════════════════════════════════════════════════

describe("已知缺陷 · Responses 族（PR-1 实测发现，证据见注释）", () => {
  /**
   * 缺陷 A：`openai-responses.ts:245` 用 `part?.type === "reasoning"` 判定推理块，
   * 但 OpenAI 规范里 `content_part.added` 的 part 类型只有三种：
   * `output_text` / `refusal` / **`reasoning_text`**（openapi.yaml:54571-54575，
   * `ReasoningTextContent.type` 枚举值为 `reasoning_text`，openapi.yaml:75568-75574）。
   * **`"reasoning"` 这个值在规范里不存在**，所以该分支恒不命中。
   *
   * 后果：真实流里推理摘要走 `response.reasoning_summary_part.added`
   * （openapi.yaml:68726-68728，解析器**完全没有这个 case**）→ `inReasoningBlock`
   * 永不置位 → 后续 `reasoning_summary_text.delta` 被当作**正文** text_delta 发出。
   * 实测结果：`responses-reasoning.json` 回放出 `text="Considering 6*742"`
   * —— 推理摘要与正文粘在一起，而 `thinking` 为空。
   *
   * 影响面：Responses 族全部思考模型（gpt-5.x 系）的思考内容会污染正文。
   * 这与 Anthropic / DeepSeek 两族的行为**不一致**，所以它是 parity 缺口而非协议差异。
   *
   * 不在本 PR 修：PR-1 的范围是「补回归网」，改解析器行为属于 fix 类改动，
   * 应单开 PR（并按 CONTRIBUTING.md 在正文说清根因）。本条 test.failing 就是那个 PR 的验收断言。
   */
  test.failing("缺陷 A：reasoning summary 应进 thinking 而不是正文", async () => {
    const r = await replayFixture("responses-reasoning.json", "openai-responses");
    expect(r.thinking).toBe("Considering 6*7");
    expect(r.text).toBe("42");
  });

  /**
   * 缺陷 B：`response.incomplete` 分支（`openai-responses.ts:358-366`）
   * **不读 `response.usage`**，而同为终态的 `response.completed` 分支读了
   * （`openai-responses.ts:330-333` 调 `applyResponsesUsage`）。
   *
   * 规范上 `response.incomplete` 的 `response` 字段是完整的 `Response` 对象
   * （openapi.yaml:67965-67966），含 usage。实测 `responses-incomplete.json`
   * 回放出 `usage={inputTokens:0, outputTokens:0}`，而夹具里明确写了 8/10。
   *
   * 后果：被 max_tokens 截断的轮次**成本记 0**。而截断轮恰恰是输出最满的轮
   * （output 打到上限），是单轮成本最高的那一类 —— 这个漏采方向性地低估成本，
   * 且正好偏在最贵的样本上。它直接影响北极星「更省」的账本口径。
   *
   * 同样不在本 PR 修，理由同缺陷 A。
   */
  test.failing("缺陷 B：response.incomplete 应采 usage（截断轮成本不应记 0）", async () => {
    const r = await replayFixture("responses-incomplete.json", "openai-responses");
    expect(r.usage.inputTokens).toBe(8);
    expect(r.usage.outputTokens).toBe(10);
  });
});

describe("已知缺陷 · Anthropic 流内 error 结构化字段丢失（PR-1 实测发现）", () => {
  /**
   * 缺陷 C：`anthropic.ts:634` 的 `case "error"` 在真实 SDK 路径上**不可达**。
   *
   * 证据链（三步，全部回源实测）：
   *   1. Anthropic SDK `core/streaming.js:44-49` 只 yield 六种事件
   *      （message_start / message_delta / message_stop / content_block_*），
   *      `error` 不在其中；
   *   2. 同文件 `:62-63` 对 `sse.event === 'error'` **直接 `throw new APIError(...)`**；
   *   3. 于是流在 provider 的 for-await 里抛出 → 落到 `anthropic.ts:668` 的 catch，
   *      那里只 `yield { type:"error", error:{ message: err.message } }`
   *      —— **`type` 与 `streamLevel: true` 都没带上**。
   *
   * 为什么此前没被发现：现有测试（`stream-level-error.test.ts:116-123` 等）在
   * **Provider 层**造假流，直接 yield 一个已经带 `type`/`streamLevel` 的 error 事件，
   * 绕过了整个 SDK。也就是说它测的是「fallback 拿到结构化字段后分类对不对」，
   * 而不是「provider 到底给不给得出结构化字段」。VCR 从**字节层**回放才暴露这一段。
   *
   * 后果分两档（实测 `classifyError` / `classifyStreamError` 的真实返回值）：
   *   - 错误消息里**恰好含** `overloaded` 关键词时：`classifyError` 靠关键词兜住，
   *     仍得 `RetryableError(overloaded)` —— 所以线上没炸，是**运气**，
   *     因为 SDK 把整个 body JSON 塞进了 message，关键词恰好在里面。
   *   - 消息里**没有**关键词时（如 `api_error` + "服务暂时不可用"）：
   *     `streamLevel` 丢失 → 走 `classifyError` → 实测返回**裸 `Error`**（reason undefined），
   *     **既不重试也不降级**。而带上 `type` 走 `classifyStreamError` 会得到
   *     `StreamLevelError(server_error)`，是可重试的。
   *
   * 这正是 `errors.ts:711-712` 注释警告过的形态：「不能靠关键词匹配，要用 provider
   * 明确给出的错误类型」—— 而 provider 这条路径恰恰没能给出来。
   *
   * 不在本 PR 修（PR-1 的范围是补回归网）。修法方向：catch 里判 `err` 是否
   * `APIError` 并从 `err.error`（SDK 保留了解析后的 body，`core/error.js:15`）
   * 取回 `type`，再带上 `streamLevel: true`。本条 test.failing 是那个 PR 的验收断言。
   */
  test.failing("缺陷 C：SDK throw 的流内 error 应还原出结构化 type + streamLevel", async () => {
    const r = await replayFixture("anthropic-stream-error.json", "anthropic-messages");
    const errEvent = r.events.find((e) => e.type === "error") as any;
    expect(errEvent.error?.type).toBe("overloaded_error");
    expect(errEvent.error?.streamLevel).toBe(true);
  });
});
