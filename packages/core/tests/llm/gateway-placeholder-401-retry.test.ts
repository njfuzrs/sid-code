/**
 * 16 号 C1 门禁：网关 401 占位句不得一次 Terminal
 *
 * ## 拦的是什么
 *
 * A2 五题（`regex-log` / `polyglot-c-py` / `sanitize-git-repo` / `polyglot-rust-c` /
 * `rstan-to-pystan`）的死因是网关回 `Invalid token. (request id: …)` 且带
 * `statusCode=401`：`classifyError` 判成 `TerminalError("auth_failed")`，
 * B1-b 的 retry-once 闸门放一次之后第二个 401 立刻 Terminal → self-fallback
 * （评测里 fallbackModel 故意指回自己）→ 整轮 `error_during_execution`。
 * 前三题 cc 同题解出，即**我们的 key 是好的，是网关在抖**。
 *
 * ## 为什么断言「第二次以后仍在重试」而不是「RetryTelemetry > 0」
 *
 * 16 §2.1 明确否决后者：修复前五题**已经** > 0（`auth_refresh` 本身就是一条
 * RetryTelemetry），拿它当判据会假绿。所以本文件一律数 **provider 被调用的次数**。
 *
 * ## 为什么每条用例都挂 statusCode
 *
 * 生产路径是 `StreamLevelError.statusCode=401`，正文里既没有边界 `401` 也没有认证
 * 关键词（request id 里的数字被 `hasBoundaryDigits` 排除）。只在 `is401Error` 的
 * 文本表里加 `"invalid token"` 的版本**在生产路径上测不到** —— 16 §4 的 ⛔ 之一。
 *
 * ## 两种到达形态都要覆盖
 *
 * 占位句有两条路进来，少测一条就只修好一半（本文件第 3 个 test）：
 *   · throw（建流即抛）→ 直接进 catch → C1 闸门；
 *   · **流内 `error` 事件且不带 `streamLevel`**（本网关真实形态，`type` 是空字符串，
 *     见 status-code-classification.test.ts）→ classifyError → 401 → TerminalError
 *     → 那条分支上有个 `return`，**绕过 catch**。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import { isGatewayPlaceholderAuthError, classifyError } from "@sid-code/core/llm/errors.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

/** 实测原文（A2 会话 20260908-211221-eed2cadb 等五题首句）。 */
const PLACEHOLDER_MSG = "Invalid token. (request id: 20260908211221456789abcdef)";
/** 真 key 作废的厂商 SDK 措辞 —— 必须仍 Terminal。 */
const REAL_BAD_KEY_MSG = "authentication_error: invalid x-api-key";

const BASE_PARAMS: SendParams = {
  model: "primary-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 100,
};

const OK_EVENTS: StreamEvent[] = [
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { inputTokens: 1, outputTokens: 1 },
  },
  { type: "message_stop" },
];

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function err401(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 401 });
}

/** 快退避：避免真实等待撞 bun 默认 5s 单测超时。 */
function fastConfig(extra: Record<string, unknown> = {}) {
  return {
    availability: new ModelAvailabilityService(),
    retryBackoffBaseMs: 1,
    retryBackoffMaxMs: 5,
    streamTimeoutMs: 5000,
    // 占位句重试要消耗 attempt 预算，给够上界才能观察到 3 次封顶。
    maxRetries: 10,
    maxRetriesPerCall: 12,
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────
// 第 1 层：判据本身（纯函数）
// ─────────────────────────────────────────────────────────────────

describe("C1 判据：占位句与真 key 作废必须分得开", () => {
  test("statusCode=401 + Invalid token → 占位句", () => {
    expect(isGatewayPlaceholderAuthError(err401(PLACEHOLDER_MSG))).toBe(true);
  });

  test("真 invalid x-api-key 即便带 401 也不是占位句（优先否决）", () => {
    expect(isGatewayPlaceholderAuthError(err401(REAL_BAD_KEY_MSG))).toBe(false);
    // 且它仍走 Terminal —— 用户要立刻看到「去换 key」，不该白等 3 次退避。
    expect(classifyError(err401(REAL_BAD_KEY_MSG)).name).toBe("TerminalError");
  });

  test("没有结构化 401 时不成立：文本里的数字可能来自 request id", () => {
    // 只有正文没有状态码 → 不认。这条守的是 hasBoundaryDigits 那起事故的反面：
    // 不能因为「正文里有 invalid token」就放行一个未必是 401 的错误。
    expect(isGatewayPlaceholderAuthError(new Error(PLACEHOLDER_MSG))).toBe(false);
  });

  test("复合措辞：authentication_error 与 Invalid token 同时出现时，真 key 作废优先", () => {
    // 这一格是 REAL_AUTH_FAILURE_MESSAGES 那张表**唯一**的生效场景，也是它存在的全部理由。
    // 变异自证逼出来的（删掉那张表时，上面那些用例全绿）：只有正文同时命中两边时，
    // 「优先否决」才真的在做事。少这一格，那张表就是死代码 —— 本仓「死接线」那一类。
    //
    // 判据方向：网关把上游的认证错误**原样转发**时会带上 `authentication_error`，
    // 那说明是凭据真的不被接受，不是网关自己在抖 —— 该 Terminal，不该重试 3 次。
    const compound = err401("authentication_error: Invalid token. (request id: 20260908211221)");
    expect(isGatewayPlaceholderAuthError(compound)).toBe(false);
    expect(classifyError(compound).name).toBe("TerminalError");
  });

  test("措辞不透明的 401（多半真是 key 配错）不当占位句", () => {
    // 刻意用正向白名单而非「401 且不是真 key 作废」的反向判据：
    // 反向判据会把这条也拖进 3 次退避，把「立刻告知」换成「慢 3 倍再告知」。
    expect(isGatewayPlaceholderAuthError(err401("401 Unauthorized"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// 第 2 层：漏斗行为 —— 数 provider 调用次数，不数 RetryTelemetry
// ─────────────────────────────────────────────────────────────────

describe("C1 门禁①：占位句在 retry-once 之后仍在重试", () => {
  test("前两次占位句 → 第三次成功（修复前：第二次就 Terminal + 降级）", async () => {
    let calls = 0;
    const provider: Provider = {
      name: () => "mock",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        calls++;
        if (calls <= 2) throw err401(PLACEHOLDER_MSG);
        for (const e of OK_EVENTS) yield e;
      },
    };

    const availability = new ModelAvailabilityService();
    const fallback = new ModelFallback(fastConfig({ availability }));
    const events = await collect(fallback.executeWithFallback(provider, BASE_PARAMS));

    // 判据就在这个数字上：修复前 calls===2（B1-b 放一次，第二个 401 落 Terminal）。
    expect(calls).toBe(3);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    // 没换模型：占位句是在主模型上自愈的。
    expect(fallback.checkFallbackOccurred()).toBe(false);
    // 也没被拉黑 —— 拉黑会让同一会话后续轮次全部跳过这个模型。
    expect(availability.isAvailable("primary-model").available).toBe(true);
  });

  test("占位句封顶 3 次：第 4 次不再重试 → 降级", async () => {
    let calls = 0;
    const provider: Provider = {
      name: () => "mock",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        calls++;
        throw err401(PLACEHOLDER_MSG);
      },
    };
    const backup: Provider = {
      name: () => "backup",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        for (const e of OK_EVENTS) yield e;
      },
    };

    const fallback = new ModelFallback(
      fastConfig({
        fallbackProvider: backup,
        fallbackModel: "backup-model",
        fallbackSwitchMode: "auto",
      }),
    );
    const events = await collect(fallback.executeWithFallback(provider, BASE_PARAMS));

    // 1 次首发 + 3 次占位句重试 = 4。封顶存在的理由：不把这次调用的全部重试预算
    // （maxRetriesPerCall=12）喂给一个可能压根不会恢复的网关故障，
    // 否则之后真正该重试的 429/529 一次都轮不到。
    expect(calls).toBe(4);
    expect(fallback.checkFallbackOccurred()).toBe(true);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });

  test("流内 error 事件形态（不带 streamLevel）同样进重试 —— 绕不过 catch", async () => {
    // 这是本网关的**真实形态**：`type` 是空字符串 → anthropic.ts 的
    // `upstreamType &&` 条件不成立 → streamLevel 与 type 都不带上。
    // 它走 classifyError → 401 → TerminalError → 那条分支的 return，**不经过 catch**。
    let calls = 0;
    const provider: Provider = {
      name: () => "mock",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        calls++;
        if (calls === 1) {
          yield {
            type: "error",
            // 刻意不带 streamLevel / type —— 改这里就测不到原缺陷了。
            error: { message: PLACEHOLDER_MSG, statusCode: 401 },
          };
          return;
        }
        for (const e of OK_EVENTS) yield e;
      },
    };

    const availability = new ModelAvailabilityService();
    const fallback = new ModelFallback(fastConfig({ availability }));
    const events = await collect(fallback.executeWithFallback(provider, BASE_PARAMS));

    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(fallback.checkFallbackOccurred()).toBe(false);
    expect(availability.isAvailable("primary-model").available).toBe(true);
  });
});

describe("C1 门禁②：真 key 作废仍必须一次到底", () => {
  test("invalid x-api-key → retry-once 之后 Terminal + 降级（不吃 3 次占位句预算）", async () => {
    let calls = 0;
    const provider: Provider = {
      name: () => "mock",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        calls++;
        throw err401(REAL_BAD_KEY_MSG);
      },
    };
    const backup: Provider = {
      name: () => "backup",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        for (const e of OK_EVENTS) yield e;
      },
    };

    const fallback = new ModelFallback(
      fastConfig({
        fallbackProvider: backup,
        fallbackModel: "backup-model",
        fallbackSwitchMode: "auto",
      }),
    );
    await collect(fallback.executeWithFallback(provider, BASE_PARAMS));

    // 仍是 B1-b 的原语义：放一次（覆盖凭据瞬时失效），第二次 Terminal。
    // ⛔ 不能变成 4 —— 那说明 C1 把真 key 作废也拖进了占位句通道。
    expect(calls).toBe(2);
    expect(fallback.checkFallbackOccurred()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// 第 3 层：变异自证（CLAUDE.md 要求：新增门禁必做）
// ─────────────────────────────────────────────────────────────────

describe("C1 变异自证：上面的数字真的由 C1 判据决定", () => {
  test("把占位句换成措辞不透明的 401 → 立刻退回 calls===2 的旧行为", async () => {
    // 若 C1 的判据失效成「所有 401 都重试 3 次」，这条会变成 4 并失败。
    // 即：它证明前面那个 3/4 不是「所有 401 都被放宽」的副产物。
    let calls = 0;
    const provider: Provider = {
      name: () => "mock",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        calls++;
        throw err401("401 Unauthorized");
      },
    };
    const backup: Provider = {
      name: () => "backup",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        for (const e of OK_EVENTS) yield e;
      },
    };

    const fallback = new ModelFallback(
      fastConfig({
        fallbackProvider: backup,
        fallbackModel: "backup-model",
        fallbackSwitchMode: "auto",
      }),
    );
    await collect(fallback.executeWithFallback(provider, BASE_PARAMS));
    expect(calls).toBe(2);
  });

  test("耗尽文案带得出根因（占位句原文），不是一句「重试次数用尽」", async () => {
    // B2（缺口 D）那条教训的同形：耗尽出口丢掉根因，排查方向会跑偏到超时/网络配置。
    const provider: Provider = {
      name: () => "mock",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        throw err401(PLACEHOLDER_MSG);
      },
    };
    // 无 fallback 目标 → 走「fallback 已用尽 / 未配置」那条 error 出口。
    const fallback = new ModelFallback(fastConfig({ fallbackSwitchMode: "off" }));
    const events = await collect(fallback.executeWithFallback(provider, BASE_PARAMS));

    const errText = events
      .filter((e) => e.type === "error")
      .map((e) => (e as { error: { message: string } }).error.message)
      .join("\n");
    expect(errText).toContain("Invalid token");
  });
});
