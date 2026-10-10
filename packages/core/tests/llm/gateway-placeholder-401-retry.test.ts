/**
 * 网关 401 占位句 / 认证类错误：观测证据制下的漏斗行为
 *
 * ## 历史（为什么这个文件还在）
 *
 * 原 16 号 C1 门禁：A2 五题死于网关回 `Invalid token. (request id: …)` + `statusCode=401`，
 * 旧 `classifyError` 判 `TerminalError("auth_failed")`，B1-b retry-once 闸门放一次后
 * 第二个 401 即判死 → 整轮 `error_during_execution`。C1 当时加了「占位句白名单 3 次封顶」。
 *
 * 2026-10-08 有意语义变更：`classifyError` / `TerminalError` / `isGatewayPlaceholderAuthError`、
 * retry-once 闸门、占位句 3 次闸门**全部删除**。现在所有 401/403/认证文案（含占位句、
 * `Token已失效`、`invalid x-api-key`、不透明的 `401 Unauthorized`）一律归 `auth_suspect`，
 * 由 `recovery-policy.ts` 按「同一指纹连续出现 3 次即放弃本次调用」判定；
 * 措辞白名单（真 key 作废）只缩短退避，不再减少次数。
 *
 * ## 判据仍然是 provider 调用次数
 *
 * 不数 RetryTelemetry：`auth_refresh` 本身就是一条 RetryTelemetry，拿它当判据会假绿。
 *
 * ## 两种到达形态（throw / 流内 event 带或不带 streamLevel）命运必须相同
 *
 * 旧实现里事件路径绕过 catch，闸门只修好一半（会话 20261008-173228-baeb949d：
 * `Token已失效，请重试` 5ms 内判死，零重试）。现在三种形态都先归一化再进同一个
 * `decideRecovery`，本文件逐一断言调用次数与结局一致。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import { FAMILY_MAX_ATTEMPTS } from "@sid-code/core/llm/recovery-policy.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

/** 实测原文（A2 会话 20260908-211221-eed2cadb 等五题首句）。 */
const PLACEHOLDER_MSG = "Invalid token. (request id: 20260908211221456789abcdef)";
/** 实测原文（会话 20261008-173228-baeb949d）。 */
const TOKEN_EXPIRED_MSG = "Token已失效，请重试";
/** 真 key 作废的厂商 SDK 措辞。 */
const REAL_BAD_KEY_MSG = "authentication_error: invalid x-api-key";

/** auth_suspect 同指纹的最多尝试次数（含首次）。引用常量，避免两处数字漂移。 */
const AUTH_CAP = FAMILY_MAX_ATTEMPTS.auth_suspect;

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

/** 零退避：不许真睡（auth_suspect 的 2s/8s 最小间隔在 backoffBaseMs=0 时一并归零）。 */
function fastConfig(extra: Record<string, unknown> = {}) {
  return {
    availability: new ModelAvailabilityService(),
    retryBackoffBaseMs: 0,
    retryBackoffMaxMs: 0,
    streamTimeoutMs: 5000,
    // 给足调用方预算，确保观察到的封顶来自 auth_suspect 族预算而非调用方上界。
    maxRetries: 10,
    maxRetriesPerCall: 12,
    ...extra,
  };
}

function backupProvider(): Provider {
  return {
    name: () => "backup",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      for (const e of OK_EVENTS) yield e;
    },
  };
}

/** 三种到达形态：每次调用都以同一条 401 失败。 */
type Arrival = "throw" | "event_no_streamLevel" | "event_streamLevel";
function failingProvider(message: string, arrival: Arrival, counter: { calls: number }): Provider {
  return {
    name: () => "mock",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      counter.calls++;
      if (arrival === "throw") throw err401(message);
      yield {
        type: "error",
        // event_no_streamLevel 是本网关真实形态（type 为空字符串 → 不带 streamLevel / type）。
        error:
          arrival === "event_streamLevel"
            ? { message, statusCode: 401, streamLevel: true }
            : { message, statusCode: 401 },
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 第 1 层：自愈 —— 占位句是网关在抖，重试后主模型恢复
// ─────────────────────────────────────────────────────────────────

describe("认证类错误：同指纹 3 次以内自愈不换模型、不拉黑", () => {
  for (const msg of [PLACEHOLDER_MSG, TOKEN_EXPIRED_MSG]) {
    test(`前两次「${msg.slice(0, 16)}…」→ 第三次成功`, async () => {
      let calls = 0;
      const provider: Provider = {
        name: () => "mock",
        async *sendMessageStream(): AsyncIterable<StreamEvent> {
          calls++;
          if (calls <= 2) throw err401(msg);
          for (const e of OK_EVENTS) yield e;
        },
      };

      const availability = new ModelAvailabilityService();
      const fallback = new ModelFallback(fastConfig({ availability }));
      const events = await collect(fallback.executeWithFallback(provider, BASE_PARAMS));

      expect(calls).toBe(3);
      expect(events.some((e) => e.type === "message_stop")).toBe(true);
      expect(fallback.checkFallbackOccurred()).toBe(false);
      expect(availability.isSuspect("primary-model")).toBe(false);
    });
  }
});

// ─────────────────────────────────────────────────────────────────
// 第 2 层：同指纹 3 次后放弃 —— 三种到达形态命运相同
// ─────────────────────────────────────────────────────────────────

describe("同指纹 3 次后放弃本次调用：throw / 事件（带或不带 streamLevel）命运相同", () => {
  const arrivals: Arrival[] = ["throw", "event_no_streamLevel", "event_streamLevel"];
  for (const msg of [PLACEHOLDER_MSG, TOKEN_EXPIRED_MSG, REAL_BAD_KEY_MSG]) {
    for (const arrival of arrivals) {
      test(`${arrival}「${msg.slice(0, 16)}…」→ ${AUTH_CAP} 次后降级`, async () => {
        const counter = { calls: 0 };
        const availability = new ModelAvailabilityService();
        const fallback = new ModelFallback(
          fastConfig({
            availability,
            fallbackProvider: backupProvider(),
            fallbackModel: "backup-model",
            fallbackSwitchMode: "auto",
          }),
        );
        const events = await collect(
          fallback.executeWithFallback(failingProvider(msg, arrival, counter), BASE_PARAMS),
        );

        // 2026-10-08 有意语义变更：旧行为是占位句 4 次（1+3）、真 key 作废 2 次
        // （retry-once 后 Terminal）、事件形态 1 次（绕过 catch 直接判死）。
        // 现在一律 auth_suspect 同指纹 3 次；真 key 措辞只缩短退避，不减次数。
        expect(counter.calls).toBe(AUTH_CAP);
        expect(fallback.checkFallbackOccurred()).toBe(true);
        expect(events.some((e) => e.type === "message_stop")).toBe(true);
        // 放弃写嫌疑（短期、有 TTL），不是永久拉黑：主线程照常放行。
        expect(availability.isSuspect("primary-model")).toBe(true);
        expect(availability.isAvailable("primary-model", "main_thread").available).toBe(true);
      });
    }
  }

  test("措辞不透明的 401 Unauthorized 同样 3 次（不再 retry-once 判死）", async () => {
    // 2026-10-08 有意语义变更：旧行为 calls===2。
    const counter = { calls: 0 };
    const fallback = new ModelFallback(
      fastConfig({
        fallbackProvider: backupProvider(),
        fallbackModel: "backup-model",
        fallbackSwitchMode: "auto",
      }),
    );
    await collect(
      fallback.executeWithFallback(
        failingProvider("401 Unauthorized", "throw", counter),
        BASE_PARAMS,
      ),
    );
    expect(counter.calls).toBe(AUTH_CAP);
  });
});

// ─────────────────────────────────────────────────────────────────
// 第 3 层：指纹变化重新计数（变异自证：封顶真的按指纹而不是按状态码累计）
// ─────────────────────────────────────────────────────────────────

describe("指纹变化重新计数", () => {
  test("A,A,B,B → 第 5 次成功：两种 401 各自都没到 3 次", async () => {
    // 若封顶退化成「同族累计」，第 3 次（B）就会放弃 → calls===3 并降级，本用例失败。
    const seq = [PLACEHOLDER_MSG, PLACEHOLDER_MSG, TOKEN_EXPIRED_MSG, TOKEN_EXPIRED_MSG];
    let calls = 0;
    const provider: Provider = {
      name: () => "mock",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        const msg = seq[calls];
        calls++;
        if (msg) throw err401(msg);
        for (const e of OK_EVENTS) yield e;
      },
    };
    const fallback = new ModelFallback(fastConfig());
    const events = await collect(fallback.executeWithFallback(provider, BASE_PARAMS));

    expect(calls).toBe(5);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(fallback.checkFallbackOccurred()).toBe(false);
  });

  test("request id 不同不算换指纹：同一占位句换 request id 仍 3 次封顶", async () => {
    // 指纹归一化去掉 request id；否则网关每次换 id 就能无限重试、吃满整份预算。
    let calls = 0;
    const provider: Provider = {
      name: () => "mock",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        calls++;
        throw err401(`Invalid token. (request id: 2026090821122${calls}abcdef0123)`);
      },
    };
    const fallback = new ModelFallback(
      fastConfig({
        fallbackProvider: backupProvider(),
        fallbackModel: "backup-model",
        fallbackSwitchMode: "auto",
      }),
    );
    await collect(fallback.executeWithFallback(provider, BASE_PARAMS));
    expect(calls).toBe(AUTH_CAP);
  });
});

// ─────────────────────────────────────────────────────────────────
// 第 4 层：耗尽文案带根因
// ─────────────────────────────────────────────────────────────────

describe("耗尽出口带得出根因原文", () => {
  test("降级禁用时 error 文案含占位句原文，不是一句「重试次数用尽」", async () => {
    // B2（缺口 D）教训：耗尽出口丢掉根因，排查方向会跑偏到超时/网络配置。
    const counter = { calls: 0 };
    const fallback = new ModelFallback(fastConfig({ fallbackSwitchMode: "off" }));
    const events = await collect(
      fallback.executeWithFallback(failingProvider(PLACEHOLDER_MSG, "throw", counter), BASE_PARAMS),
    );

    const errText = events
      .filter((e) => e.type === "error")
      .map((e) => (e as { error: { message: string } }).error.message)
      .join("\n");
    expect(counter.calls).toBe(AUTH_CAP);
    expect(errText).toContain("Invalid token");
    expect(errText).toContain("auth_suspect");
  });
});
