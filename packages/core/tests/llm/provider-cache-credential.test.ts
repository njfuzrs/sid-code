/**
 * 行为回归：同 baseURL 下的双凭据不再串用（2026-11-05 A8 实测缺陷）。
 *
 * 缺陷文档：docs-research/sid-code/bugfixes/todo/20261105-Provider缓存键缺凭据维度-同baseURL多账户串用.md
 *
 * ── 为什么单测（registry.test.ts 的 T1）不够 ──
 *
 * T1 只证明「缓存分了实例」。真正让用户受损的是**请求头里的凭据**：provider 的凭据在
 * 构造时被实例捕获（`openai.ts` 的 `private apiKey` → 请求时 `Authorization: Bearer ...`），
 * 所以只有走到真实请求，才能证明「降级请求带的是降级目标那份 key」。
 *
 * ── 为什么按 app.ts 的顺序取实例 ──
 *
 * 生产路径（`app.ts:1437-1446`）：降级 provider 在 **App 构造期**就经
 * `registry.getProviderFor` 取好实例，交给 `ModelFallback` 长期持有。`clearCache()`
 * 只清 registry 的 Map，不触及已交出去的引用 —— 所以修复必须发生在**取实例那一刻**
 * （缓存键带凭据），事后清理救不了。
 *
 * 修复前形态（A8 实测）：降级 provider 命中主模型的缓存实例 → 降级请求仍带 A → 401 →
 * 看起来像「降级没生效」。修复后：降级请求带 B → 正常结束。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

const ENDPOINT = "https://gw.example.com/v1";
const KEY_PRIMARY = "sk-account-A";
const KEY_FALLBACK = "sk-account-B";

/** 主模型与降级目标：同 provider、同 baseURL、不同 apiKey（缺陷文档 §2.1 的最小形态）。 */
function testConfig(): Config {
  return {
    ...defaultConfig(),
    provider: "openai",
    model: "primary-model",
    openaiKey: KEY_PRIMARY,
    baseURL: ENDPOINT,
    availableModels: [
      { name: "primary-model", provider: "openai", baseURL: ENDPOINT, apiKey: KEY_PRIMARY },
      { name: "fallback-model", provider: "openai", baseURL: ENDPOINT, apiKey: KEY_FALLBACK },
    ],
    fallbackModel: "fallback-model",
  };
}

const PARAMS: SendParams = {
  model: "primary-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 64,
};

/** 正常结束的 OpenAI SSE（最小形态，够走到 message_stop）。 */
function okSse(): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(
        enc.encode(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
        ),
      );
      c.enqueue(
        enc.encode(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        ),
      );
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("F1 行为：同 baseURL 双凭据的降级请求必须带降级目标的 key", () => {
  const realFetch = globalThis.fetch;
  let authSeen: string[];

  beforeEach(() => {
    authSeen = [];
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const auth = String(init?.headers?.Authorization ?? "");
      authSeen.push(auth);
      // 账户 A 的 key 在这个网关上无效；账户 B 有效。
      if (auth === `Bearer ${KEY_PRIMARY}`) {
        return new Response("invalid api key", {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      if (auth === `Bearer ${KEY_FALLBACK}`) return okSse();
      return new Response("unexpected credential", { status: 403 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("主模型 401 后，降级请求携带降级条目自己的 key 并正常结束", async () => {
    const cfg = testConfig();
    const registry = new ProviderRegistry(cfg);

    // 顺序与生产一致：主 provider 先建，降级 provider 随后按条目取（app.ts:1437-1446）。
    const primary = registry.getProvider();
    const fbCfg = cfg.availableModels!.find((m) => m.name === cfg.fallbackModel)!;
    const fallbackProvider = registry.getProviderFor(
      fbCfg.provider!,
      fbCfg.apiKey || "",
      fbCfg.baseURL,
    );

    const fallback = new ModelFallback({
      availability: new ModelAvailabilityService(),
      fallbackProvider,
      fallbackModel: "fallback-model",
      // 零退避：本用例测的是凭据传递，不是退避时长（auth_suspect 族的最小间隔一并归零）。
      retryBackoffBaseMs: 0,
      retryBackoffMaxMs: 0,
      streamTimeoutMs: 5000,
    });

    const events: StreamEvent[] = [];
    for await (const e of fallback.executeWithFallback(primary, PARAMS)) events.push(e);

    // 主模型确实用 A 发过请求 —— 否则这条用例没覆盖到降级路径，等于假绿。
    expect(authSeen).toContain(`Bearer ${KEY_PRIMARY}`);
    // 关键断言：修复前这里一条 B 都不会出现（降级 provider 就是主 provider 那个实例）。
    expect(authSeen.filter((a) => a === `Bearer ${KEY_FALLBACK}`).length).toBeGreaterThan(0);
    // 整轮正常结束
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });
});
