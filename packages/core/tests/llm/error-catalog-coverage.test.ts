/**
 * 回归门禁：cc 官方《错误参考》页列出的每条运行时错误，都必须能被分类成
 * **有具体建议**的文案，而不是退化成通用「运行错误」。
 *
 * 为什么把官方页当基准：那页是"用户真会在终端看到的原文"的最全清单（服务器 / 用量 /
 * 认证 / 网络 / 请求五族）。sid-code 走同一套 Claude API 与网关，这些措辞会**原样**
 * 流到我们的错误面板。实测基线：修复前 46 条里 36 条落到 `undefined` → 通用兜底
 * （即用户看到「运行错误 / 请检查错误详情」这句毫无信息量的话）。
 *
 * 本文件锁三件事：
 * 1. **覆盖率**：46 条全部有 code，且每个 code 在文案表里有条目（不推空卡片）；
 * 2. **不误判**：放宽关键词后，既有分类一条都不许被抢走（含数字边界那两个陷阱）；
 * 3. **瞬态语义**：额度 / 上下文 / 拒答必须是**终态**——被判成瞬态会在请求一恢复时
 *    自动清掉卡片，而这三类都需要用户干预。这是加新码时最容易踩的坑。
 *
 * 新增错误码时：先在这里加一行期望，再去改 `inferErrorCode`。
 */

import { describe, test, expect } from "bun:test";
import {
  inferErrorCode,
  isTransientErrorCode,
  ERROR_USER_MESSAGES,
} from "@sid-code/core/llm/error-messages.ts";

/** 官方《错误参考》页的字面消息，按页面分节组织。 */
const CATALOG: Record<string, string[]> = {
  服务器: [
    "API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment.",
    "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary.",
    "API Error: Server error mid-response. The response above may be incomplete.",
    "API Error: Connection closed mid-response. The response above may be incomplete.",
    "API Error: Response stalled mid-stream. The response above may be incomplete.",
    "Request timed out",
    "Agent terminated early due to an API error: upstream failure",
  ],
  用量: [
    "You've hit your session limit · resets 3:45pm",
    "You've hit your weekly limit · resets Mon 12:00am",
    "You've hit your Opus limit · resets 3:45pm",
    "API Error: Usage credits required for 1M context · run /usage-credits to turn them on",
    "API Error: Server is temporarily limiting requests (not your usage limit)",
    "API Error: Request rejected (429) · this may be a temporary capacity issue.",
    "Credit balance is too low",
  ],
  认证: [
    "Not logged in · Please run /login",
    "Could not resolve authentication method",
    "Invalid API key",
    "Your apiKeyHelper script is failing",
    "This organization has been disabled",
    "Your organization has disabled API key authentication",
    "OAuth token revoked",
    "OAuth token has expired",
    "Login expired · Please run /login",
    "Failed to authenticate: OAuth session expired and could not be refreshed",
    "AWS credentials expired or invalid",
    "AWS authentication failed",
    "AWS default-chain credential resolve timed out",
  ],
  网络: [
    "Unable to connect to API",
    "SSL certificate verification failed",
    'Bedrock streaming response has content-type "text/html"; expected "application/vnd.amazon.eventstream"',
  ],
  请求: [
    "Prompt is too long",
    "Error during compaction: Conversation too long",
    "Request too large",
    "Image was too large",
    "PDF too large",
    "PDF is password protected",
    "Extra inputs are not permitted",
    "There's an issue with the selected model",
    "Model foo-9 is not a recognized model id",
    "Claude Opus is not available with the Claude Pro plan",
    "Model x is restricted by your organization's settings",
    "thinking.type.enabled is not supported for this model",
    "max_tokens must be greater than thinking.budget_tokens",
    "API Error: 400 due to tool use concurrency issues",
    "Claude Code is unable to respond to this request, which appears to violate our Usage Policy",
    "claude-opus-5 has safety measures that flagged this message for a cybersecurity topic",
  ],
};

describe("官方错误目录全覆盖（修复前 36/46 落到通用兜底）", () => {
  for (const [section, messages] of Object.entries(CATALOG)) {
    test(`${section}族：每条都能分类且有具体文案`, () => {
      const misses: string[] = [];
      for (const msg of messages) {
        const code = inferErrorCode(msg);
        if (!code || !ERROR_USER_MESSAGES[code]) {
          misses.push(`${String(code)} <== ${msg.slice(0, 60)}`);
        }
      }
      // 断言里带上未覆盖清单，红的时候直接能看出漏了哪条。
      expect(misses).toEqual([]);
    });
  }

  test("总覆盖数不回退（46 条）", () => {
    const all = Object.values(CATALOG).flat();
    expect(all.length).toBe(46);
    expect(all.filter((m) => !inferErrorCode(m))).toEqual([]);
  });
});

describe("放宽关键词后不许误判既有分类", () => {
  // 每条都带"为什么容易被抢走"，避免后人以为是冗余用例而删掉。
  const cases: [string, string | undefined, string][] = [
    [
      "502 Upstream connection error: Server disconnected",
      "server_error",
      "含 connection，不得被 no_finish_reason 抢",
    ],
    [
      "insufficient_quota: billing limit reached",
      "quota_exhausted",
      "含 limit，不得被 usage_limit_reached 抢",
    ],
    ["Rate limit exceeded, retry after 30s", "rate_limit", "含 limit，同上"],
    [
      "Quota exceeded for this organization",
      "quota_exhausted",
      "含 organization，不得被 auth_failed 抢",
    ],
    ["Unauthorized: invalid api key", "auth_failed", ""],
    ["Request timed out after 60s", "timeout", ""],
    ["请求超时（已重试 3 次）", "timeout", ""],
    ["model_not_found: gpt-5-turbo does not exist", "model_not_found", ""],
    ["529 overloaded", "overloaded", ""],
    ["xyzzy unrecognizable", undefined, "真正无法识别的仍须是 undefined，不能被泛化关键词吸走"],
  ];
  for (const [msg, expected, why] of cases) {
    test(`${msg.slice(0, 44)}${why ? ` — ${why}` : ""}`, () => {
      expect(inferErrorCode(msg)).toBe(expected);
    });
  }

  test("数字边界陷阱不回退（request id / 耗时里的巧合数字）", () => {
    expect(inferErrorCode("gateway trace 5024 内部错误")).toBeUndefined();
    expect(inferErrorCode("耗时 4001ms 后失败")).toBeUndefined();
    expect(
      inferErrorCode("上游错误 (request id: 20260905194229773007594196e93ae3)"),
    ).toBeUndefined();
  });
});

describe("语义边界：措辞相近但用户动作相反的几组", () => {
  test("usage policy（内容被拒）≠ usage limit（额度用尽）", () => {
    expect(
      inferErrorCode(
        "Claude Code is unable to respond to this request, which appears to violate our Usage Policy",
      ),
    ).toBe("content_policy");
    expect(inferErrorCode("You've hit your session limit · resets 3:45pm")).toBe(
      "usage_limit_reached",
    );
  });

  test("上下文溢出（/compact）≠ 附件过大（改请求）", () => {
    // 都含 "too"，但正确动作不同：前者压缩对话，后者换小附件。
    expect(inferErrorCode("prompt is too long: 137500 tokens > 135000 maximum")).toBe(
      "context_overflow",
    );
    expect(inferErrorCode("Image was too large")).toBe("invalid_request");
  });

  test("用量上限 ≠ 限流：一个要等重置/换模型，一个系统自己会重试", () => {
    expect(isTransientErrorCode(inferErrorCode("You've hit your weekly limit"))).toBe(false);
    expect(isTransientErrorCode(inferErrorCode("HTTP 429: Too Many Requests"))).toBe(true);
  });

  test("「短期限流」含 usage limit 子串但**否认**是配额 → 必须是瞬态", () => {
    // 官方原文：`Server is temporarily limiting requests (not your usage limit)`。
    // 子串匹配的经典陷阱：它含 "usage limit"，若被 usage_limit_reached 抢走就成了终态，
    // 红卡在请求恢复后永久悬挂 —— 本仓库已修过一次同形缺陷（限流卡片不消失）。
    const msg = "API Error: Server is temporarily limiting requests (not your usage limit)";
    expect(inferErrorCode(msg)).toBe("rate_limit");
    expect(isTransientErrorCode(inferErrorCode(msg))).toBe(true);
  });
});

describe("瞬态语义：需用户干预的错误绝不能被自动清掉", () => {
  // 判据见 error-messages.ts 的 TRANSIENT_ERROR_CODES 注释：
  // 瞬态卡片会在"请求恢复"信号到来时自动消失，终态卡片必须留到用户处理。
  const terminal = [
    "usage_limit_reached",
    "context_overflow",
    "content_policy",
    "auth_failed",
    "quota_exhausted",
    "model_not_found",
    "subagent_failed",
  ];
  for (const code of terminal) {
    test(`${code} 是终态（留在界面上）`, () => {
      expect(isTransientErrorCode(code)).toBe(false);
      expect(ERROR_USER_MESSAGES[code]).toBeDefined();
    });
  }

  const transient = ["rate_limit", "overloaded", "network_error", "no_finish_reason", "timeout"];
  for (const code of transient) {
    test(`${code} 是瞬态（恢复后自动消失）`, () => {
      expect(isTransientErrorCode(code)).toBe(true);
    });
  }
});
