/**
 * F2（2026-11-04）：网关「额度不足」403 按上游 code 归为额度耗尽，并跨循环共享。
 *
 * ── 事故形态（会话 `20261103-213816-f5beebde`）──
 *
 * 网关回 `HTTP 403`：
 *   `{"error":{"message":"令牌[...]额度不足","type":"shell_api_error","code":"pre_consume_token_quota_failed"}}`
 *
 * 分类器判成 `auth_suspect`（鉴权可疑），主循环 + 3 个并行子代理各按 `auth_suspect` 的
 * 3 次预算重试，合计 12 发注定被拒的请求。用户看到的文案是「API Key 无效或已过期」，
 * 照着去换 key 永远修不好。
 *
 * ── 三层根因与本文件的对应关系 ──
 *
 * 1. **provider 层没解析正文**（`openai.ts` 的 `!response.ok` 只带 message + statusCode）
 *    → 第 1 组用例钉 `parseUpstreamErrorBody` + `pickUpstreamTag` 的解析口径；
 * 2. **`byUpstreamType` 不认额度类 code**、且额度判定必须早于 authentication/permission
 *    → 第 2 组用例（含 `permission_denied_quota` 这种组合 code）；
 * 3. **状态码直接定案，词表根本没被查** → 第 3 组用例（401/403 的额度窄口）；
 * 4. **跨循环放大**（每条循环自己撞满预算）→ 第 5 组用例（账户级标记）。
 *
 * ── 变异自证（方案 §3.5 要求，写完在这里，见文末「变异自证」段）──
 *
 * 把 `classifyFamily` 里的 401/403 窄口删掉，第 3 组必须全红；
 * 把 `byUpstreamType` 的额度判定删掉，第 2 组必须全红；
 * 把 `recordGiveUp` 里的 `markQuotaExhausted` 删掉，第 5 组的「第二次不发请求」必须红。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import {
  classifyFamily,
  normalizeStreamEvent,
  normalizeThrown,
  type FamilyVerdict,
} from "@sid-code/core/llm/error-normalize.ts";
import { parseUpstreamErrorBody, pickUpstreamTag } from "@sid-code/core/llm/upstream-error-body.ts";
import { codeFromStructured } from "@sid-code/core/llm/error-messages.ts";
import { matchQuotaLexicon } from "@sid-code/core/llm/error-lexicon.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import { makeQuotaScope } from "@sid-code/core/llm/quota-scope.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

const PARAMS = { model: "gpt-6.1-sol", messages: [], maxTokens: 500 } as unknown as SendParams;

/**
 * 本会话真实 403 正文，逐字照抄。
 *
 * 三处细节都是复现的必要条件，改任何一处就测不到原缺陷：
 *   - `type` 是**泛化外壳** `shell_api_error`（没有判别力）
 *   - 具体原因只在 `code: "pre_consume_token_quota_failed"`
 *   - `message` 是中文「令牌[...]额度不足」（旧词表一条都认不出）
 */
const REAL_403_BODY = {
  error: {
    message: "令牌[sk-***]额度不足",
    type: "shell_api_error",
    code: "pre_consume_token_quota_failed",
  },
};

/** 本会话真实的流内 error 事件形态（Responses 路径 `!response.ok` 的产物）。 */
function real403Event(tag: string | undefined) {
  return {
    message: `OpenAI Responses API HTTP 403: ${JSON.stringify(REAL_403_BODY)}`,
    statusCode: 403,
    ...(tag !== undefined && { type: tag }),
  };
}

function classifyEvent(payload: ReturnType<typeof real403Event>): FamilyVerdict {
  return classifyFamily(normalizeStreamEvent(payload));
}

function classifyThrown(message: string, status?: number): FamilyVerdict {
  const err =
    status !== undefined ? Object.assign(new Error(message), { status }) : new Error(message);
  return classifyFamily(normalizeThrown(err));
}

// ════════════════════════════════════════════════════════════════════
// 第 1 组：provider 层解析（F2 ①）
// ════════════════════════════════════════════════════════════════════

describe("F2 ① — parseUpstreamErrorBody 把上游 type/code 解析出来", () => {
  test("本会话真实 403 正文：type 与 code 都解析出来", () => {
    const body = parseUpstreamErrorBody(JSON.stringify(REAL_403_BODY));
    expect(body.type).toBe("shell_api_error");
    expect(body.code).toBe("pre_consume_token_quota_failed");
    expect(body.message).toBe("令牌[sk-***]额度不足");
  });

  test("pickUpstreamTag 用 code 优先：泛化壳 type 不遮蔽具体 code", () => {
    // 这是 F2 ① 的核心判据。反过来（type 优先）就有判别力的信息被丢掉，
    // 分类器只能看到 shell_api_error → 落到 byStatus(403) → auth_suspect。
    const body = parseUpstreamErrorBody(JSON.stringify(REAL_403_BODY));
    expect(pickUpstreamTag(body)).toBe("pre_consume_token_quota_failed");
  });

  test("官方形态（无 code）回落到 type：Anthropic overloaded_error", () => {
    const body = parseUpstreamErrorBody(
      JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "…" } }),
    );
    expect(pickUpstreamTag(body)).toBe("overloaded_error");
  });

  test("OpenAI 官方形态：code 为 null 时回落 type", () => {
    const body = parseUpstreamErrorBody(
      JSON.stringify({ error: { message: "…", type: "invalid_request_error", code: null } }),
    );
    expect(pickUpstreamTag(body)).toBe("invalid_request_error");
  });

  test("非 JSON / 空 body / 纯字符串 error 一律返回空对象（永不抛错）", () => {
    // 错误路径上再抛一个新错误，只会把原始根因盖掉。
    expect(parseUpstreamErrorBody("<html>502 Bad Gateway</html>")).toEqual({});
    expect(parseUpstreamErrorBody("")).toEqual({});
    expect(parseUpstreamErrorBody("   ")).toEqual({});
    expect(parseUpstreamErrorBody(JSON.stringify({ error: "plain string" }))).toEqual({});
  });

  test('外层哨兵 `type:"error"` 不被当成标签', () => {
    const body = parseUpstreamErrorBody(JSON.stringify({ type: "error", message: "x" }));
    expect(pickUpstreamTag(body)).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════
// 第 2 组：byUpstreamType 认额度类 code（F2 ②）
// ════════════════════════════════════════════════════════════════════

describe("F2 ② — 结构化 code 命中额度类即归 request_suspect / quota_exhausted", () => {
  test("【核心回归】真实 403 + 真实 code → quota_exhausted（不再判鉴权可疑）", () => {
    const v = classifyEvent(real403Event("pre_consume_token_quota_failed"));
    expect(v.family).toBe("request_suspect");
    expect(v.reason).toBe("quota_exhausted");
    expect(v.recognized).toBe(true);
  });

  test("额度类 code 不依赖状态码：无 statusCode 也能认出", () => {
    const v = classifyFamily(
      normalizeStreamEvent({ message: "quota failed", type: "insufficient_quota" }),
    );
    expect(v.family).toBe("request_suspect");
    expect(v.reason).toBe("quota_exhausted");
  });

  test("组合 code `permission_denied_quota` 走额度而不是鉴权（额度语义更具体）", () => {
    const v = classifyEvent({ message: "x", statusCode: 403, type: "permission_denied_quota" });
    expect(v.reason).toBe("quota_exhausted");
  });

  test("反例：真鉴权 403 仍是 auth_suspect（不被额度判定误伤）", () => {
    const v = classifyEvent({
      message: "organization has been disabled",
      statusCode: 403,
      type: "permission_error",
    });
    expect(v.family).toBe("auth_suspect");
    expect(v.reason).toBe("auth_failed");
  });

  test("反例：`shell_api_error` 这个泛化壳本身不产生任何判定", () => {
    // 它既不含 quota 也不含 authentication，byUpstreamType 应当返回 undefined，
    // 由状态码接手。这条钉住「泛化壳不被当成 5xx / 额度」。
    const v = classifyEvent({ message: "上游异常", statusCode: 502, type: "shell_api_error" });
    expect(v.family).toBe("transient");
    expect(v.reason).toBe("server_error");
  });

  test("反例：`load_balancer_unavailable` 不被当成额度 code（词边界，不是裸子串）", () => {
    // 2026-11-04 复核修复：`QUOTA_TAG_MARKERS` 此前用裸 `includes`，`balance` 命中
    // `load_balancer_unavailable`（balancer 里含 balance），一次 LB 故障会被判成
    // quota_exhausted 并写进账户级共享标记，同账户所有并行循环 60s 内一发不发。
    const v = classifyEvent({
      message: "load balancer unavailable",
      statusCode: 502,
      type: "load_balancer_unavailable",
    });
    expect(v.family).toBe("transient");
    expect(v.reason).toBe("server_error");
    expect(v.reason).not.toBe("quota_exhausted");
  });

  test("复数形态 `insufficient_credits` 仍判额度（`credits` 单列的理由）", () => {
    // 词边界会把 `credit` 后的 `s` 当成同一个词，所以 marker 表里必须另有 `credits`。
    const v = classifyEvent({
      message: "x",
      statusCode: 402,
      type: "insufficient_credits",
    });
    expect(v.family).toBe("request_suspect");
    expect(v.reason).toBe("quota_exhausted");
  });
});

// ════════════════════════════════════════════════════════════════════
// 第 3 组：401/403 的额度窄口（F2 ③ + ④）
// ════════════════════════════════════════════════════════════════════

describe("F2 ③④ — 网关只在 message 写额度时（无 code），403 仍归额度耗尽", () => {
  test("【核心回归】`令牌额度不足` + 403、不带任何 type → quota_exhausted", () => {
    // ⚠️ 这条是【窄口】的专属用例：预期里没有 code，byUpstreamType 拿不到东西，
    // 全靠 `classifyFamily` 在 byStatus(401/403) 之前查额度词表。
    // 把窄口删掉这条立刻变红（方案 §3.5 要求的变异自证就是它）。
    const v = classifyEvent(real403Event(undefined));
    expect(v.family).toBe("request_suspect");
    expect(v.reason).toBe("quota_exhausted");
  });

  test("无状态码的纯文本 `令牌额度不足` → quota_exhausted", () => {
    const v = classifyThrown("令牌额度不足，请充值后重试");
    expect(v.family).toBe("request_suspect");
    expect(v.reason).toBe("quota_exhausted");
  });

  test("`额度不足` / `quota_failed` / `令牌额度` 三条新词都进词表", () => {
    expect(matchQuotaLexicon("额度不足")).toBe("quota_exhausted");
    expect(matchQuotaLexicon("token quota_failed")).toBe("quota_exhausted");
    expect(matchQuotaLexicon("令牌额度已耗尽")).toBe("quota_exhausted");
  });

  test("余额不足 / 欠费 / 请充值 的老词条不受影响", () => {
    for (const msg of ["余额不足", "账户欠费", "请充值后再试", "insufficient_quota"]) {
      expect(matchQuotaLexicon(msg)).toBe("quota_exhausted");
    }
  });

  test("窄口不放宽到 401/403 之外：400 + 额度文案仍按 invalid_request", () => {
    // 「有边界的例外」的边界：只对 401/403 开。400 的额度文案更可能是参数问题。
    const v = classifyEvent({ message: "额度不足", statusCode: 400 });
    expect(v.family).toBe("request_suspect");
    expect(v.reason).toBe("invalid_request");
  });

  test("反例：`not your usage limit`（官方明说不是配额）不被窄口采信", () => {
    // 这句含 "usage limit" 子串，顺序反了就会把短期限流判成额度耗尽。
    const v = classifyEvent({
      message: "Server is temporarily limiting requests (not your usage limit)",
      statusCode: 403,
    });
    expect(v.family).toBe("auth_suspect");
    expect(v.reason).toBe("auth_failed");
  });

  test("反例：真鉴权 403（无额度文案）仍按状态码判 auth_suspect", () => {
    const v = classifyEvent({ message: "invalid x-api-key", statusCode: 403 });
    expect(v.family).toBe("auth_suspect");
  });
});

// ════════════════════════════════════════════════════════════════════
// 第 4 组：面板文案与漏斗判族同源（F2 ⑤）
// ════════════════════════════════════════════════════════════════════

describe("F2 ⑤ — codeFromStructured 复用唯一分类器", () => {
  test("【核心回归】403 + 额度 code → 面板显示 quota_exhausted（此前是 auth_failed）", () => {
    expect(codeFromStructured(403, "pre_consume_token_quota_failed")).toBe("quota_exhausted");
    expect(codeFromStructured(403, "insufficient_quota")).toBe("quota_exhausted");
  });

  test("反例：403 + 真鉴权 type 仍是 auth_failed", () => {
    expect(codeFromStructured(403, "permission_error")).toBe("auth_failed");
    expect(codeFromStructured(403, undefined)).toBe("auth_failed");
  });

  test("既有映射不回退（状态码族）", () => {
    expect(codeFromStructured(402)).toBe("quota_exhausted");
    expect(codeFromStructured(404)).toBe("model_not_found");
    expect(codeFromStructured(408)).toBe("request_timeout");
    expect(codeFromStructured(409)).toBe("lock_timeout");
    expect(codeFromStructured(400)).toBe("invalid_request");
    expect(codeFromStructured(429)).toBe("rate_limit");
    expect(codeFromStructured(503)).toBe("overloaded");
    expect(codeFromStructured(502)).toBe("server_error");
  });

  test("既有映射不回退（type 族，收敛到 byUpstreamType 后仍认）", () => {
    expect(codeFromStructured(400, "content_policy_violation")).toBe("content_policy");
    expect(codeFromStructured(500, "overloaded_error")).toBe("overloaded");
    expect(codeFromStructured(undefined, "server_error")).toBe("server_error");
  });

  test("认不出的结构化输入返回 undefined（调用方回落 inferErrorCode）", () => {
    expect(codeFromStructured(undefined, undefined)).toBeUndefined();
    expect(codeFromStructured(418, "")).toBeUndefined();
    expect(codeFromStructured(undefined, "shell_api_error")).toBeUndefined();
  });

  test("【同源补漏】403 + 只在 message 写额度、无 code → 面板也判 quota_exhausted", () => {
    // 2026-11-04 复核修复：此前本函数传 `message: ""`，额度窄口拿不到东西，
    // 于是「网关只在 message 写额度」这条路径上漏斗判额度、面板仍显示「API Key 无效」。
    // 第三个参数只在 401/403 参与窄口，其余状态码仍只看结构化字段。
    const realMessage = `LLM 错误: OpenAI Responses API HTTP 403: {"error":{"message":"令牌[sk-***]额度不足","type":"shell_api_error","code":"pre_consume_token_quota_failed"}}`;
    // 有 code 时走结构化判据（沿用原行为）
    expect(codeFromStructured(403, "pre_consume_token_quota_failed", realMessage)).toBe(
      "quota_exhausted",
    );
    // 无 code、只有中文额度文案时，靠窄口补上 —— 这是本次修复的那条裂缝
    expect(codeFromStructured(403, undefined, realMessage)).toBe("quota_exhausted");
  });

  test("message 参数不会放宽到 401/403 之外，也不会误伤真鉴权", () => {
    // 边界 ①：非 401/403 一律不读 message，保持「文本推断只有 inferErrorCode 一条路」
    expect(codeFromStructured(500, undefined, "令牌额度不足")).toBe("server_error");
    expect(codeFromStructured(400, undefined, "令牌额度不足")).toBe("invalid_request");
    // 边界 ②：403 但文案是真鉴权 → 仍 auth_failed
    expect(codeFromStructured(403, undefined, "invalid x-api-key")).toBe("auth_failed");
    // 边界 ③：401 同理
    expect(codeFromStructured(401, undefined, "令牌额度不足")).toBe("quota_exhausted");
    expect(codeFromStructured(401, undefined, "unauthorized")).toBe("auth_failed");
  });
});

// ════════════════════════════════════════════════════════════════════
// 第 5 组：账户级额度标记（F2 ⑥）
// ════════════════════════════════════════════════════════════════════

interface QuotaProbe {
  provider: any;
  counts: { stream: number };
}

/**
 * 生产真实形态：流内 `error` 事件，带 statusCode + 上游 code（provider 层已解析）。
 *
 * `withTag=false` 用于测「网关只写 message」的路径（窄口）。
 */
function quotaStream(opts: { withTag?: boolean; message?: string } = {}): QuotaProbe {
  const counts = { stream: 0 };
  const provider: any = {
    name: () => "gateway",
    // 账户级作用域：同一端点 + 同一凭据。测试里用固定值，等价于「同一个账户」。
    quotaScope: () => makeQuotaScope("https://gw.example.com/v1", "sk-test-key"),
    sendMessageStream: function (): AsyncGenerator<StreamEvent> {
      counts.stream++;
      return (async function* () {
        yield {
          type: "error",
          error: {
            message:
              opts.message ?? `OpenAI Responses API HTTP 403: ${JSON.stringify(REAL_403_BODY)}`,
            statusCode: 403,
            ...(opts.withTag !== false && { type: "pre_consume_token_quota_failed" }),
          },
        } as unknown as StreamEvent;
      })();
    },
  };
  return { provider, counts };
}

function makeFallback(
  extra: Record<string, unknown> = {},
  availability = new ModelAvailabilityService(),
) {
  return new ModelFallback({
    availability,
    retryBackoffBaseMs: 0,
    retryBackoffMaxMs: 0,
    maxRetries: 2,
    streamTimeoutMs: 30_000,
    ...extra,
  });
}

async function drain(
  fb: ModelFallback,
  provider: any,
  querySource = "agent:builtin",
  perCall: Record<string, unknown> = {},
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  try {
    for await (const e of fb.executeWithFallback(provider, PARAMS, undefined, {
      querySource,
      switchMode: "auto",
      ...perCall,
    } as any)) {
      out.push(e);
    }
  } catch {
    /* 只看副作用（发了几次请求），不看抛不抛 */
  }
  return out;
}

describe("F2 ⑥ — 额度耗尽标记按 (端点, 凭据) 跨循环共享", () => {
  test("【核心回归】第一条循环判定额度耗尽后，同账户的第二次调用不发 HTTP 直接失败", async () => {
    const availability = new ModelAvailabilityService();
    const { provider, counts } = quotaStream();

    // 第一条循环：request_suspect 族预算 = 2 次尝试，撞满后放弃并写标记
    await drain(makeFallback({}, availability), provider);
    expect(counts.stream).toBe(2); // 修前是 2 次（族预算），修后仍是 2 —— 它自己是"第一条"
    expect(
      availability.getQuotaExhausted(makeQuotaScope("https://gw.example.com/v1", "sk-test-key")),
    ).toBeDefined();

    // 第二条循环（模拟并行子代理）：命中标记，一次请求都不发
    const before = counts.stream;
    await drain(makeFallback({}, availability), provider);
    expect(counts.stream).toBe(before);
  });

  test("换个凭据就不命中（换 key = 换账户，应当重新探测）", async () => {
    const availability = new ModelAvailabilityService();
    const { provider, counts } = quotaStream();
    await drain(makeFallback({}, availability), provider);

    const otherKey: any = {
      ...provider,
      quotaScope: () => makeQuotaScope("https://gw.example.com/v1", "sk-other-key"),
    };
    const before = counts.stream;
    await drain(makeFallback({}, availability), otherKey);
    expect(counts.stream).toBe(before + 2);
  });

  test("换端点也不命中（另一个网关是另一个账户）", async () => {
    const availability = new ModelAvailabilityService();
    const { provider, counts } = quotaStream();
    await drain(makeFallback({}, availability), provider);

    const otherEndpoint: any = {
      ...provider,
      quotaScope: () => makeQuotaScope("https://other.example.com/v1", "sk-test-key"),
    };
    const before = counts.stream;
    await drain(makeFallback({}, availability), otherEndpoint);
    expect(counts.stream).toBe(before + 2);
  });

  test("主线程 / headless 豁免：用户主动重发必须真实发出请求", async () => {
    // 豁免是「请求成功即清除标记」这条自愈出口的唯一实现路径。
    // 不豁免 = 用户充值后重发也发不出去 = 死锁。
    const availability = new ModelAvailabilityService();
    const { provider, counts } = quotaStream();
    await drain(makeFallback({}, availability), provider);

    for (const source of ["main_thread", "headless"]) {
      const before = counts.stream;
      await drain(makeFallback({}, availability), provider, source);
      expect(counts.stream).toBe(before + 2);
    }
  });

  test("不实现 quotaScope 的 provider 一律放行（fail-open）", async () => {
    const availability = new ModelAvailabilityService();
    const { provider, counts } = quotaStream();
    await drain(makeFallback({}, availability), provider);

    const noScope: any = { name: () => "legacy", sendMessageStream: provider.sendMessageStream };
    const before = counts.stream;
    await drain(makeFallback({}, availability), noScope);
    expect(counts.stream).toBe(before + 2);
  });

  test("成功产出一次即清除标记（充值后无需等 TTL）", async () => {
    const availability = new ModelAvailabilityService();
    const { provider, counts } = quotaStream();
    await drain(makeFallback({}, availability), provider);

    // 换成「成功产出」的 provider（同账户），应清除标记。
    // ⚠️ 这里必须用 `main_thread`（豁免来源）：额度标记生效期间，非豁免路径
    // 连请求都发不出去，**根本走不到「成功」**。而主线程豁免正是这条自愈出口的
    // 唯一实现路径 —— 用户充值后重发消息 → 真实请求 → 成功 → 清除标记。
    const okProvider: any = {
      name: () => "gateway",
      quotaScope: () => makeQuotaScope("https://gw.example.com/v1", "sk-test-key"),
      sendMessageStream: () =>
        (async function* () {
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          };
          yield { type: "message_stop" };
        })(),
    };
    await drain(makeFallback({}, availability), okProvider, "main_thread");
    expect(
      availability.getQuotaExhausted(makeQuotaScope("https://gw.example.com/v1", "sk-test-key")),
    ).toBeUndefined();

    // 再回到会失败的 provider：标记已清，应该重新真实发请求（2 次）
    const before = counts.stream;
    await drain(makeFallback({}, availability), provider);
    expect(counts.stream).toBe(before + 2);
  });

  test("额度耗尽不写模型嫌疑（额度是账户级的，不是模型坏了）", async () => {
    const availability = new ModelAvailabilityService();
    const { provider } = quotaStream();
    await drain(makeFallback({}, availability), provider);
    // 若误用 markSuspect，下一个模型（同账户）会被 suspect 拦一次；
    // 这里直接断言「没有写嫌疑」——额度问题不该让用户去换模型。
    expect(availability.isSuspect(PARAMS.model)).toBe(false);
  });

  test("用户选 retry_same 清除标记并真实重发（方案 §3.5 验收项）", async () => {
    const availability = new ModelAvailabilityService();
    const scope = makeQuotaScope("https://gw.example.com/v1", "sk-test-key");
    // 预置标记：模拟「同账户已被别的循环判定额度耗尽」—— 此时本路连请求都发不出去。
    availability.markQuotaExhausted(scope, "seeded by another loop");

    const counts = { stream: 0 };
    const okProvider: any = {
      name: () => "gateway",
      quotaScope: () => scope,
      sendMessageStream: () => {
        counts.stream++;
        return (async function* () {
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          };
          yield { type: "message_stop" };
        })();
      },
    };
    const fb = makeFallback(
      { onFallbackDecision: async () => ({ action: "retry_same" }) },
      availability,
    );
    const events = await drain(fb, okProvider, "agent:builtin", { switchMode: "ask" });

    // 时序：标记命中 → 不建流 → ask 弹窗选 retry_same → 清标记 → 递归重发 → 这次成功。
    // 清标记那一行删掉的话，递归进去仍被拦，streams 会是 0、且一路走到「无可用 fallback」。
    expect(counts.stream).toBe(1);
    expect(events.some((e) => e.type === "stream_restart" && e.reason === "retry_same")).toBe(true);
    expect(availability.getQuotaExhausted(scope)).toBeUndefined();
  });

  test("TTL 到期后标记自动失效（外部充值后唯一不依赖用户的自愈出口）", () => {
    const availability = new ModelAvailabilityService();
    const scope = makeQuotaScope("https://gw.example.com/v1", "sk-test-key");
    // ttlMs=0：立刻到期。这是方案 §3.3 ⑥ 三种清除条件之外的兜底 ——
    // 标记期内所有请求都被拦，没有它，「任意一次成功即清除」结构性地走不到（死锁）。
    availability.markQuotaExhausted(scope, "test", 0);
    expect(availability.getQuotaExhausted(scope)).toBeUndefined();
  });

  test("续期：重复 mark 把到期时刻往后推（额度没恢复就一直拦）", () => {
    const availability = new ModelAvailabilityService();
    const scope = makeQuotaScope("https://gw.example.com/v1", "sk-test-key");
    availability.markQuotaExhausted(scope, "first", 1_000);
    const first = availability.getQuotaExhausted(scope);
    expect(first).toBeDefined();

    availability.markQuotaExhausted(scope, "second", 60_000);
    const second = availability.getQuotaExhausted(scope);
    expect(second).toBeDefined();
    // 续期不是「保留首次的 until」：每次撞出来都要重新计 60s，否则长会话里
    // 一个已经过期的旧时间戳会让标记提前失效。
    expect(second!.remainingMs).toBeGreaterThan(first!.remainingMs);
    expect(second!.evidence).toBe("second");
  });

  test("usage_limit_reached 不写账户级共享标记（计划/模型级配额，不是账户余额）", async () => {
    const availability = new ModelAvailabilityService();
    // 403 + 只在 message 写「usage limit」、不给 code：窄口会采信，结论是 usage_limit_reached。
    const { provider, counts } = quotaStream({
      withTag: false,
      message: "you have hit your usage limit (HTTP 403)",
    });
    await drain(makeFallback({}, availability), provider);

    // 仍按 request_suspect 族预算撞（这是窄口的产出，不做跨循环共享）
    expect(counts.stream).toBeGreaterThan(0);
    // 但**不写**账户级标记：`hit your opus limit` 这类是模型级配额，
    // 记成 (端点, 凭据) 会让「opus 用满」连带拦住同账户还有余量的模型。
    // 这条钉住「两个额度码只有 quota_exhausted 共享」是刻意，不是漏写。
    expect(
      availability.getQuotaExhausted(makeQuotaScope("https://gw.example.com/v1", "sk-test-key")),
    ).toBeUndefined();
  });
});
