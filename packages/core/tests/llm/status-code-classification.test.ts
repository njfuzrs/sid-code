/**
 * 流内 error 事件的 statusCode 必须参与错误分类 —— 429 零重试即终止的根治（2026-08-25）。
 *
 * ── 事故形态 ──
 *
 * SWE-bench smoke-8 里 `xarray-6461` 与 `pytest-10081` 两条实例，跑到中途撞公司网关
 * 限流，**一次重试都没有**就终止整轮：19 次流式请求里 `流式阶段尝试` 全部是 `1/11`,
 * 重试计数器从没涨到 2。日志三行：
 *
 *   [FALLBACK]  流式阶段尝试 1/11               ← 有 11 次预算
 *   [LLM:ANTHROPIC] 429 当前分组上游负载已饱和    ← 真实限流
 *   [FALLBACK]  用户/钩子选择不切换，终止本轮      ← 第 1 次就放弃
 *
 * ── 根因（三层，缺一层都修不好）──
 *
 * 1. `anthropic.ts` 置 `streamLevel` 的条件是 `upstreamType &&`，而这个网关的 429 body
 *    是 `{"error":{"message":"当前分组上游负载已饱和…","type":"","code":"rate_limited"}}`
 *    —— `type` 是**空字符串**（falsy）→ streamLevel 与 type 都不带上。
 * 2. `fallback.ts` 的分类分支于是走 else：`classifyError(new Error(event.error.message))`
 *    —— **只传 message，把事件里明明有的 statusCode 丢了**。
 * 3. 于是 429 的识别退化成对 message 做文本匹配，而 `anthropic.ts` 优先用上游给的
 *    人类可读文案（那条是中文，既没有 "429" 也没有 "rate_limit"）→ 返回**裸 Error**
 *    → `classified instanceof RetryableError` 为 false → 跳过全部重试 →
 *    落到"重试耗尽"出口 → tryFallback → 无备用模型 → abort → 整轮 fatal。
 *
 * ── 为什么此前测试全绿 ──
 *
 * 既有 fallback 系测试的 mock **全部显式写 `streamLevel: true`**
 * （`fallback.test.ts` / `stream-level-error.test.ts` / `s4-*.test.ts` 皆是），
 * 恰好绕过了生产上出问题的那条 else 分支。**「绿了但没测到」的又一例。**
 * 所以本文件的核心用例刻意**不带 streamLevel**，钉死生产的真实形态。
 *
 * ── 同一批数据里的对照（这条最有说服力）──
 *
 * 同一轮 smoke-8 里 `pytest-7982` 撞的是 nginx `502 Bad Gateway`，**重试成功了**。
 * 差别只在于 502 的错误正文字面含 `502` 三个字符、被文本匹配兜住。
 * 也就是说修复前「限流能否重试」取决于**网关文案里恰好有没有那串数字** ——
 * 这不是漏了一个场景，是判据建在了错误的地方。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import {
  classifyError,
  classifyStreamError,
  RetryableError,
  StreamLevelError,
  TerminalError,
} from "@sid-code/core/llm/errors.ts";
import { inferErrorCode } from "@sid-code/core/llm/error-messages.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

const PARAMS = { model: "m1", messages: [], maxTokens: 500 } as unknown as SendParams;

/**
 * 逐字照抄 smoke-8 `xarray-6461` agent.log 里那条 429 的上游 body。
 * 三处细节都是复现的必要条件，改任何一处这个用例就测不到原缺陷：
 *   - `type` 是**空字符串**（不是缺字段）→ 决定 streamLevel 不置位
 *   - `message` 是**中文**且不含任何三位数字 → 决定文本匹配落空
 *   - 可用信息只在 `code: "rate_limited"` 里
 */
const GATEWAY_429_BODY = {
  error: {
    message: "当前分组上游负载已饱和，请稍后再试 (request id: 2026082515464415941613246213595)",
    localized_message: "Unknown error",
    type: "",
    param: "",
    code: "rate_limited",
  },
} as const;

// ════════════════════════════════════════════════════════════════════════
// 第 1 层：分类器本身 —— statusCode 在场时必须压过文本匹配
// ════════════════════════════════════════════════════════════════════════

describe("classifyError：结构化 statusCode 是权威判据", () => {
  test("【核心回归】429 + 中文文案（无任何数字）→ 必须判可重试", () => {
    const err = Object.assign(new Error(GATEWAY_429_BODY.error.message), { status: 429 });
    const c = classifyError(err);
    expect(c).toBeInstanceOf(RetryableError);
    expect((c as RetryableError).reason).toBe("rate_limit");
  });

  test("同一条中文文案不带 statusCode 也能认出来（词表，不再依赖状态码透传）", () => {
    // 这条以前是负向断言：记录「文本路径认不出中文，所以必须透传 statusCode」。
    // 2026-09-24 词表补进了「负载已饱和」，负向断言转红是修复生效的信号，不是回退。
    // statusCode 仍然是权威判据（见上一条），但不再是唯一判据。
    const c = classifyError(new Error(GATEWAY_429_BODY.error.message));
    expect(c).toBeInstanceOf(RetryableError);
    expect((c as RetryableError).reason).toBe("rate_limit");
  });

  test("各类可重试状态码 + 无数字中文文案 → 全部按状态码判定", () => {
    const cases = [
      [429, "rate_limit"],
      [502, "server_error"],
      [500, "server_error"],
      [503, "overloaded"],
      [529, "overloaded"],
    ] as const;
    for (const [status, reason] of cases) {
      const c = classifyError(Object.assign(new Error("上游异常，请稍后再试"), { status }));
      expect(c).toBeInstanceOf(RetryableError);
      expect((c as RetryableError).reason).toBe(reason);
    }
  });

  test("终端状态码不因本次改动被误判成可重试", () => {
    // 成对纪律：只钉"该重试的重试了"，把判据全放开也能变绿。
    // 403 与 402 都是 2026-09-24 补进分类表的：403 是 key 没权限 / 账号被禁用，
    // 402 是欠费，两者都不可自愈。此前这段注释把 403 排除在外，那是一道
    // 阻止修复的注释，不要再加回来。
    const cases = [
      [401, "auth_failed"],
      [403, "auth_failed"],
      [402, "quota_exhausted"],
      [404, "model_not_found"],
      [400, "invalid_request"],
    ] as const;
    for (const [status, reason] of cases) {
      const c = classifyError(Object.assign(new Error("上游拒绝"), { status }));
      expect(c).toBeInstanceOf(TerminalError);
      expect((c as TerminalError).reason).toBe(reason);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// 第 2 层：fallback 漏斗 —— 不带 streamLevel 的流内 error 事件也要进重试
// ════════════════════════════════════════════════════════════════════════

interface Probe {
  provider: any;
  counts: { stream: number };
}

/**
 * 生产真实形态的 429：流内 `error` 事件，**带 statusCode 但不带 streamLevel、不带 type**。
 * 这正是 `anthropic.ts` catch 分支在 `upstreamType` 为空字符串时 yield 出来的东西。
 */
function gateway429Stream(opts: { statusCode?: number; message?: string } = {}): Probe {
  const counts = { stream: 0 };
  const provider: any = {
    name: () => "anthropic",
    sendMessageStream: function (): AsyncGenerator<StreamEvent> {
      counts.stream++;
      return (async function* () {
        yield {
          type: "error",
          error: {
            message: opts.message ?? GATEWAY_429_BODY.error.message,
            ...(opts.statusCode !== undefined && { statusCode: opts.statusCode }),
            // 刻意不带 streamLevel / type —— 改这里就测不到原缺陷了
          },
        } as unknown as StreamEvent;
      })();
    },
  };
  return { provider, counts };
}

function makeFallback(extra: Record<string, unknown> = {}) {
  return new ModelFallback({
    availability: new ModelAvailabilityService(),
    retryBackoffBaseMs: 1,
    retryBackoffMaxMs: 3,
    // 2 = 首次 + 2 次重试。取小值只为跑得快，不改变被测语义（"有没有进重试"）。
    maxRetries: 2,
    streamTimeoutMs: 30_000,
    ...extra,
  });
}

async function drain(fb: ModelFallback, provider: any): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  try {
    for await (const e of fb.executeWithFallback(provider, PARAMS, undefined, {
      querySource: "agent:builtin",
      switchMode: "auto",
    } as any)) {
      out.push(e);
    }
  } catch {
    /* 只看副作用（发了几次请求），不看抛不抛 */
  }
  return out;
}

describe("fallback：流内 error 带 statusCode 即进重试（不依赖 streamLevel）", () => {
  test("【核心回归】429 中文文案 + statusCode → 用满重试预算，而非一次即放弃", async () => {
    const { provider, counts } = gateway429Stream({ statusCode: 429 });
    await drain(makeFallback(), provider);
    // 修复前：counts.stream === 1（第一次就转 fallback→abort）
    // 修复后：1 次首发 + 2 次重试 = 3
    expect(counts.stream).toBe(3);
  });

  test("同样的 429 中文文案、事件不带 statusCode → 词表接手，仍然重试", async () => {
    // 这条以前断言只发 1 次，记录的是「文本路径没有判据」那个能力边界。
    // 2026-09-24 词表补进了「负载已饱和」，这条边界不再成立：文案本身就是判据。
    // 真正还在的边界是「文案也不在词表里」（见本文件下方的 D7 用例）。
    const { provider, counts } = gateway429Stream({});
    await drain(makeFallback(), provider);
    expect(counts.stream).toBe(3);
  });

  test("成对：终端状态码（401）不因本改动进重试", async () => {
    const { provider, counts } = gateway429Stream({ statusCode: 401, message: "凭证无效" });
    await drain(makeFallback(), provider);
    expect(counts.stream).toBe(1);
  });

  test("同批数据里的对照形态：502 正文含数字，修复前后都该重试", async () => {
    // smoke-8 的 pytest-7982 实测走的就是这条（nginx 502 错误页），它当时**重试成功了**。
    // 留着它是为了固化那个对照：修复前 502 能重试、429 不能，差别只在文案里有没有数字。
    const { provider, counts } = gateway429Stream({
      statusCode: 502,
      message: "502 <html><head><title>502 Bad Gateway</title></head></html>",
    });
    await drain(makeFallback(), provider);
    expect(counts.stream).toBe(3);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 第 3 层：provider 侧 —— 三条协议路径都必须透传 statusCode
// ════════════════════════════════════════════════════════════════════════

describe("provider 透传契约（防「修好一条协议、另一条照旧」）", () => {
  /**
   * 用源码扫描而非行为测试，是因为要覆盖的是**三条协议路径的 catch 分支**，
   * 各自需要真实 SDK 抛错才能触发，用 mock 去逼很脆。而这里要防的漂移形态很具体：
   * 「有人新加/改动一个 yield error 点，忘了带 statusCode」。
   * 扫源码能机械地拦住它，且不依赖运行时。
   */
  const SRC = ["packages/core/src/llm/anthropic.ts", "packages/core/src/llm/openai.ts"] as const;

  test("三条协议路径的『请求异常』catch 分支都带 statusCode 透传", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    // 从测试文件位置回溯到仓库根：tests/llm/ → tests/ → core/ → packages/ → root
    const root = join(import.meta.dir, "..", "..", "..", "..");

    // 定位判据用「`请求异常`」这个日志文案：它是三处 catch（Anthropic /
    // OpenAI Chat Completions / OpenAI Responses）的共同指纹，且**只有** catch
    // 分支会打它。用它而不是用 `AUDIT:API`，是因为后者还会命中
    // `openai.ts` 的 Content-Type 分支 —— 那处是结构化的
    // `type:"server_error", streamLevel:true`，走 classifyStreamError 而非
    // classifyError，不在本契约的覆盖范围内。
    let checked = 0;
    for (const rel of SRC) {
      const src = readFileSync(join(root, rel), "utf8");
      const blocks = src.split(/`请求异常`/).slice(1);
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) {
        // 截到该 catch 内**第一个 yield 语句结束**，而不是取固定字符窗口。
        // 固定窗口试过，不行：这几个 catch 里的注释长度差一个量级
        // （anthropic 那处光注释就 3.7KB），窗口小了漏查、大了串到下个函数体，
        // 而两种失败方式都表现为"哨兵少查了一处"却仍然全绿。
        const yieldAt = b.indexOf('type: "error"');
        if (yieldAt === -1) continue;
        const yieldBlock = b.slice(yieldAt, b.indexOf("};", yieldAt) + 2);
        expect(yieldBlock).toContain("statusCode");
        checked++;
      }
    }
    // 三条协议路径一条都不许漏。数字变小 = 有 catch 分支被改成不 yield error，
    // 或日志文案被改动 —— 两种都需要人来确认，而不是让哨兵静默少查一处。
    expect(checked).toBe(3);
  });

  test("anthropic 空字符串 type 不再被当成「拿到了 type」", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(import.meta.dir, "..", "..", "..", "..");
    const src = readFileSync(join(root, "packages/core/src/llm/anthropic.ts"), "utf8");
    // 判据：必须存在"非空白才算有值"的归一（trim() !== ""），
    // 否则 `"type": ""` 会让 streamLevel 与 type 一起落空 —— 正是本次事故的第 1 层。
    expect(src).toContain('trim() !== ""');
    // 且必须把 code 作为次选纳入（这个网关把可用信息放在 code: "rate_limited"）
    expect(src).toMatch(/code/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 第 4 层：两条分类路径对同一批报文给出同一个类别
// ════════════════════════════════════════════════════════════════════════
//
// 四格是 2026-09-24 那次审查要求覆盖的全部形态。缺一格，绿了也说明不了
// 「有状态码按状态码、没状态码按词表」这两条都成立。

type Cell = { streamLevel: boolean; statusCode?: number; message: string };

/** 把一格走成生产上 fallback.ts 会走的那条分类。 */
function classifyCell(cell: Cell): { kind: "retry" | "terminal" | "unknown"; reason?: string } {
  const classified = cell.streamLevel
    ? classifyStreamError("anthropic", cell.message, undefined, cell.statusCode)
    : classifyError(
        cell.statusCode !== undefined
          ? Object.assign(new Error(cell.message), { status: cell.statusCode })
          : new Error(cell.message),
      );
  if (classified instanceof TerminalError) return { kind: "terminal", reason: classified.reason };
  if (classified instanceof RetryableError) return { kind: "retry", reason: classified.reason };
  return { kind: "unknown" };
}

describe("四格：streamLevel × statusCode 的组合都按同一张表判", () => {
  const grid: Array<[string, Cell, { kind: string; reason?: string }]> = [
    [
      "带 streamLevel + 带 statusCode：503 无 overloaded 字样 → overloaded（D2）",
      { streamLevel: true, statusCode: 503, message: "Service Unavailable" },
      { kind: "retry", reason: "overloaded" },
    ],
    [
      "带 streamLevel + 不带 statusCode：只有文案，走词表",
      { streamLevel: true, statusCode: undefined, message: "当前分组上游负载已饱和，请稍后再试" },
      { kind: "retry", reason: "rate_limit" },
    ],
    [
      "不带 streamLevel + 带 statusCode：429 中文 → rate_limit",
      { streamLevel: false, statusCode: 429, message: GATEWAY_429_BODY.error.message },
      { kind: "retry", reason: "rate_limit" },
    ],
    [
      "不带 streamLevel + 不带 statusCode：中文饱和文案 → rate_limit（D3）",
      { streamLevel: false, statusCode: undefined, message: GATEWAY_429_BODY.error.message },
      { kind: "retry", reason: "rate_limit" },
    ],
  ];

  for (const [name, cell, expected] of grid) {
    test(name, () => {
      expect(classifyCell(cell)).toEqual(expected);
    });
  }

  test("带 streamLevel 的 400/404/402 是 Terminal，不是重试（D1）", () => {
    // 这三格是本次的核心回归：修之前 classifyStreamError 把 statusCode 丢了，
    // 三条全部兜底成 StreamLevelError("server_error")，各自重试 10 次。
    const cases = [
      [400, "invalid_request"],
      [404, "model_not_found"],
      [402, "quota_exhausted"],
    ] as const;
    for (const [status, reason] of cases) {
      const c = classifyStreamError("anthropic", "something broke", undefined, status);
      expect(c).toBeInstanceOf(TerminalError);
      expect(c).not.toBeInstanceOf(StreamLevelError);
      expect((c as TerminalError).reason).toBe(reason);
    }
  });

  test("D7：纯文本 Service Unavailable（无数字、无 overloaded）仍然不重试", () => {
    // 认不出的保持 fail-fast。放开它，D1 描述的事故会从反方向发生。
    const c = classifyError(new Error("Service Unavailable"));
    expect(c).not.toBeInstanceOf(RetryableError);
    expect(c).not.toBeInstanceOf(TerminalError);
  });
});

describe('真实网关报文回放（不是手写的 new Error("503 Service Unavailable")）', () => {
  test("503 + body system disk overloaded → overloaded", () => {
    // 2026-09-24 Claude Code 收到的那条。含 overloaded，两条路径都该判过载。
    const body = "503 system disk overloaded";
    expect(classifyCell({ streamLevel: true, statusCode: 503, message: body }).reason).toBe(
      "overloaded",
    );
    expect(classifyCell({ streamLevel: false, statusCode: 503, message: body }).reason).toBe(
      "overloaded",
    );
  });

  test("429 中文 + type 空 + code 缺失 → 不再依赖 code 字段（smoke-8 去掉后来补的 code）", () => {
    // smoke-8 的 body 是 {"type":"","code":"rate_limited"}。anthropic.ts 后来靠
    // code 兜住了，所以「只给中文、什么结构化字段都不给」这条从没被验证过。
    const message = "当前分组上游负载已饱和，请稍后再试";
    expect(classifyCell({ streamLevel: false, message }).reason).toBe("rate_limit");
    expect(classifyCell({ streamLevel: true, statusCode: 429, message }).reason).toBe("rate_limit");
  });

  test("402 + 余额不足 → 终端，不重试", () => {
    const message = "当前分组余额不足，请充值后再试";
    for (const cell of [
      { streamLevel: true, statusCode: 402, message },
      { streamLevel: false, statusCode: 402, message },
      { streamLevel: false, message },
    ] as Cell[]) {
      expect(classifyCell(cell)).toEqual({ kind: "terminal", reason: "quota_exhausted" });
    }
  });

  test("400 + 任意 body → 不重试", () => {
    const c = classifyCell({
      streamLevel: true,
      statusCode: 400,
      message: "anything at all, even overloaded",
    });
    expect(c).toEqual({ kind: "terminal", reason: "invalid_request" });
  });
});

describe("词表不再分叉：classifyError 与 inferErrorCode 对同一批报文类别一致", () => {
  // 一个 overloaded、一个 rate_limit 算不一致。注释防不住这件事——
  // 两个文件的注释当时就在说同一件事，代码还是分叉了。
  const messages = [
    "503 system disk overloaded",
    "Service Unavailable",
    "当前分组上游负载已饱和，请稍后再试",
    "Server is temporarily limiting requests (not your usage limit)",
    "The API is at capacity",
    "当前分组余额不足，请充值后再试",
    "Insufficient Balance",
    "You've hit your session limit · resets 3:45pm",
    "额度已用尽",
    "HTTP 402 Payment Required",
    "HTTP 403 Forbidden",
    "429 Too Many Requests",
    "请求过于频繁",
  ];

  /** 面板码里只有重试决策真正消费的那部分才参与对账。 */
  const RETRY_DECISION = new Set([
    "auth_failed",
    "model_not_found",
    "quota_exhausted",
    "content_policy",
    "invalid_request",
    "usage_limit_reached",
    "rate_limit",
    "overloaded",
    "request_timeout",
    "lock_timeout",
    "server_error",
    "timeout",
    "network_error",
  ]);

  for (const message of messages) {
    test(message.slice(0, 40), () => {
      const panel = inferErrorCode(message);
      const classified = classifyError(new Error(message));
      const retry =
        classified instanceof TerminalError || classified instanceof RetryableError
          ? classified.reason
          : undefined;
      if (panel && RETRY_DECISION.has(panel)) {
        expect(retry).toBe(panel);
      } else {
        // 面板也认不出，或认出来的是面板专属码（context_overflow 等）→ 重试侧不该独有一个码
        expect(retry).toBeUndefined();
      }
    });
  }

  test("英文词按词边界：capacities / merge conflict 不被误伤", () => {
    expect(inferErrorCode("the capacities are listed below")).toBeUndefined();
    expect(classifyError(new Error("git merge conflict in foo.ts"))).not.toBeInstanceOf(
      RetryableError,
    );
  });

  test("裸 network 不把散文故障拖进重试（network down 必须无法分类）", () => {
    // 2026-09-24 CI 回归：词表把面板侧的裸 `network` 子串原样搬进重试分类器，
    // `new Error("network down")` 从「无法分类 → 不重试」变成 RetryableError("network_error")。
    // compact 路径因此对一条确定性失败退避重试（maxRetries 2、基数 1s，约 3s），
    // compact-analytics.test.ts 把五条路径串在同一用例里的那条在 bun 默认 5s 超时处被掐断，
    // 超时后的事件泄漏又让下一个用例「期望 1 收到 2」。
    // 真网络故障不靠这个词：`.code` 走 getNetworkErrorCode，文案走 RETRYABLE_CONNECTION_MESSAGES。
    for (const prose of ["network down", "network partition between replicas"]) {
      expect(inferErrorCode(prose)).toBeUndefined();
      const classified = classifyError(new Error(prose));
      expect(classified).not.toBeInstanceOf(RetryableError);
      expect(classified).not.toBeInstanceOf(TerminalError);
    }
    // 收窄不得误伤真故障：这两条仍然要重试
    expect(inferErrorCode("Network error: ENOTFOUND api.example.com")).toBe("network_error");
    expect(classifyError(new Error("network error"))).toBeInstanceOf(RetryableError);
  });
});
