/**
 * 错误分类体系测试
 * Task 1：classifyError() 对各种错误信息的分类准确性
 */

import { describe, test, expect } from "bun:test";
import {
  classifyError,
  TerminalError,
  RetryableError,
  StreamValidationError,
  getNetworkErrorCode,
  isAbortError,
  RequestAbortedError,
  ABORT_REASONS,
} from "../../src/llm/errors.ts";

describe("classifyError", () => {
  // === Terminal 错误 ===
  describe("Terminal 错误", () => {
    test("401 认证失败", () => {
      const err = classifyError(new Error("HTTP 401 Unauthorized"));
      expect(err).toBeInstanceOf(TerminalError);
      expect((err as TerminalError).reason).toBe("auth_failed");
    });

    test("invalid api key", () => {
      const err = classifyError(new Error("Invalid API Key provided"));
      expect(err).toBeInstanceOf(TerminalError);
      expect((err as TerminalError).reason).toBe("auth_failed");
    });

    test("authentication 失败", () => {
      const err = classifyError(new Error("Authentication failed"));
      expect(err).toBeInstanceOf(TerminalError);
      expect((err as TerminalError).reason).toBe("auth_failed");
    });

    test("404 模型不存在", () => {
      const err = classifyError(new Error("404 model_not_found"));
      expect(err).toBeInstanceOf(TerminalError);
      expect((err as TerminalError).reason).toBe("model_not_found");
    });

    test("not found", () => {
      const err = classifyError(new Error("The model was not found"));
      expect(err).toBeInstanceOf(TerminalError);
      expect((err as TerminalError).reason).toBe("model_not_found");
    });

    test("content_policy 拒绝", () => {
      const err = classifyError(new Error("content_policy violation detected"));
      expect(err).toBeInstanceOf(TerminalError);
      expect((err as TerminalError).reason).toBe("content_policy");
    });

    test("safety 拒绝", () => {
      const err = classifyError(new Error("Safety filter triggered"));
      expect(err).toBeInstanceOf(TerminalError);
      expect((err as TerminalError).reason).toBe("content_policy");
    });

    test("400 无效请求", () => {
      const err = classifyError(new Error("400 Bad Request: invalid_request"));
      expect(err).toBeInstanceOf(TerminalError);
      expect((err as TerminalError).reason).toBe("invalid_request");
    });
  });

  // === Retryable 错误 ===
  describe("Retryable 错误", () => {
    test("429 限流", () => {
      const err = classifyError(new Error("429 Too Many Requests"));
      expect(err).toBeInstanceOf(RetryableError);
      expect((err as RetryableError).reason).toBe("rate_limit");
    });

    test("rate_limit 错误", () => {
      const err = classifyError(new Error("rate_limit_error: too many requests"));
      expect(err).toBeInstanceOf(RetryableError);
      expect((err as RetryableError).reason).toBe("rate_limit");
    });

    test("429 带 retry-after 解析", () => {
      const err = classifyError(new Error('429 rate_limit retry-after: 30'));
      expect(err).toBeInstanceOf(RetryableError);
      expect((err as RetryableError).reason).toBe("rate_limit");
      expect((err as RetryableError).retryAfterMs).toBe(30000);
    });

    test("overloaded 过载", () => {
      const err = classifyError(new Error("overloaded_error: server is busy"));
      expect(err).toBeInstanceOf(RetryableError);
      expect((err as RetryableError).reason).toBe("overloaded");
    });

    test("503 过载", () => {
      const err = classifyError(new Error("503 Service Unavailable"));
      expect(err).toBeInstanceOf(RetryableError);
      expect((err as RetryableError).reason).toBe("overloaded");
    });

    test("502 服务端错误", () => {
      const err = classifyError(new Error("502 Bad Gateway"));
      expect(err).toBeInstanceOf(RetryableError);
      expect((err as RetryableError).reason).toBe("server_error");
    });

    test("500 服务端错误", () => {
      const err = classifyError(new Error("500 Internal Server Error"));
      expect(err).toBeInstanceOf(RetryableError);
      expect((err as RetryableError).reason).toBe("server_error");
    });

    test("timeout 超时", () => {
      const err = classifyError(new Error("Request timeout after 30s"));
      expect(err).toBeInstanceOf(RetryableError);
      expect((err as RetryableError).reason).toBe("timeout");
    });

    test("ETIMEDOUT 超时", () => {
      const err = classifyError(new Error("connect ETIMEDOUT 1.2.3.4:443"));
      expect(err).toBeInstanceOf(RetryableError);
      expect((err as RetryableError).reason).toBe("timeout");
    });
  });

  // === 网络错误码 ===
  describe("网络错误码", () => {
    test("ECONNRESET", () => {
      const rawErr = new Error("connection reset") as any;
      rawErr.code = "ECONNRESET";
      const err = classifyError(rawErr);
      expect(err).toBeInstanceOf(RetryableError);
      expect((err as RetryableError).reason).toBe("network_error");
    });

    test("ECONNREFUSED", () => {
      const rawErr = new Error("connection refused") as any;
      rawErr.code = "ECONNREFUSED";
      const err = classifyError(rawErr);
      expect(err).toBeInstanceOf(RetryableError);
      expect((err as RetryableError).reason).toBe("network_error");
    });

    test("ENOTFOUND", () => {
      const rawErr = new Error("DNS lookup failed") as any;
      rawErr.code = "ENOTFOUND";
      const err = classifyError(rawErr);
      expect(err).toBeInstanceOf(RetryableError);
      expect((err as RetryableError).reason).toBe("network_error");
    });

    test("EPIPE", () => {
      const rawErr = new Error("broken pipe") as any;
      rawErr.code = "EPIPE";
      const err = classifyError(rawErr);
      expect(err).toBeInstanceOf(RetryableError);
      expect((err as RetryableError).reason).toBe("network_error");
    });

    test("EAI_AGAIN", () => {
      const rawErr = new Error("DNS temporary failure") as any;
      rawErr.code = "EAI_AGAIN";
      const err = classifyError(rawErr);
      expect(err).toBeInstanceOf(RetryableError);
      expect((err as RetryableError).reason).toBe("network_error");
    });
  });

  // === 未知错误 ===
  describe("未知错误", () => {
    test("无法分类的 Error 返回原始错误", () => {
      const original = new Error("some random error");
      const err = classifyError(original);
      expect(err).toBe(original);
      expect(err).not.toBeInstanceOf(TerminalError);
      expect(err).not.toBeInstanceOf(RetryableError);
    });

    test("非 Error 对象转为 Error", () => {
      const err = classifyError("string error");
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe("string error");
    });
  });
});

describe("getNetworkErrorCode", () => {
  test("直接从 error.code 提取", () => {
    const err = new Error("fail") as any;
    err.code = "ECONNRESET";
    expect(getNetworkErrorCode(err)).toBe("ECONNRESET");
  });

  test("从 cause 链中提取（深度 2）", () => {
    const inner = new Error("inner") as any;
    inner.code = "ETIMEDOUT";
    const outer = new Error("outer", { cause: inner });
    expect(getNetworkErrorCode(outer)).toBe("ETIMEDOUT");
  });

  test("从 cause 链中提取（深度 3）", () => {
    const level3 = new Error("l3") as any;
    level3.code = "EPIPE";
    const level2 = new Error("l2", { cause: level3 });
    const level1 = new Error("l1", { cause: level2 });
    expect(getNetworkErrorCode(level1)).toBe("EPIPE");
  });

  test("超过 5 层深度返回 undefined", () => {
    let err: any = new Error("deep") as any;
    err.code = "ECONNRESET";
    for (let i = 0; i < 6; i++) {
      err = new Error(`level${i}`, { cause: err });
    }
    // 第 6 层的 code 不可达
    expect(getNetworkErrorCode(err)).toBeUndefined();
  });

  test("无 code 返回 undefined", () => {
    expect(getNetworkErrorCode(new Error("no code"))).toBeUndefined();
    expect(getNetworkErrorCode(null)).toBeUndefined();
    expect(getNetworkErrorCode(undefined)).toBeUndefined();
  });
});

describe("StreamValidationError", () => {
  test("创建 empty_response 错误", () => {
    const err = new StreamValidationError("响应为空", "empty_response");
    expect(err.name).toBe("StreamValidationError");
    expect(err.reason).toBe("empty_response");
    expect(err.message).toBe("响应为空");
  });

  test("创建 no_finish_reason 错误", () => {
    const err = new StreamValidationError("流结束但没有 finish_reason", "no_finish_reason");
    expect(err.reason).toBe("no_finish_reason");
  });

  test("创建 malformed_tool_call 错误", () => {
    const err = new StreamValidationError("工具调用 JSON 解析失败", "malformed_tool_call");
    expect(err.reason).toBe("malformed_tool_call");
  });
});

describe("isAbortError", () => {
  test("识别 RequestAbortedError", () => {
    expect(isAbortError(new RequestAbortedError("Request aborted"))).toBe(true);
  });

  test("识别 DOM AbortError", () => {
    expect(isAbortError(new DOMException("The operation was aborted.", "AbortError"))).toBe(true);
  });

  test("识别常见 abort 文本", () => {
    expect(isAbortError(new Error("Request aborted"))).toBe(true);
    expect(isAbortError(new Error("请求已中止"))).toBe(true);
  });

  test("识别 @anthropic-ai/sdk 的 APIUserAbortError 文案（回归：流超时 abort 必须被识别）", () => {
    // SDK 的 APIUserAbortError 默认 message 为 "Request was aborted."（含 was）。
    // 早期 fragment 列表只有 "request aborted"（无 was），导致流超时 abort 被误判为
    // 不可分类错误 → 静默走 fallback 而非干净传播，是 P0 僵死修复的隐藏断链。
    expect(isAbortError(new Error("Request was aborted."))).toBe(true);
  });

  test("通过 name=APIUserAbortError 识别 abort 对象", () => {
    expect(isAbortError({ name: "APIUserAbortError", message: "boom" })).toBe(true);
  });

  test("识别裸字符串 abort reason（回归：ESC 取消崩溃复发根因）", () => {
    // app.ts onInterrupt 调用 abortController.abort("user-cancel")（A6）。被取消的
    // fetch / SDK 内部 Promise 会以**裸字符串 reason** 作为 reject 值冒泡到全局
    // unhandledRejection。若 isAbortError 不认识该字符串 → 兜底当真故障 →
    // process.exit(1) 崩溃退出（实测 924a0886 会话：deepseek + ESC → SessionEnd error）。
    expect(isAbortError("user-cancel")).toBe(true);
    expect(isAbortError("timeout")).toBe(true);
    expect(isAbortError("turn-timeout")).toBe(true);
    expect(isAbortError("watchdog-timeout")).toBe(true);
  });

  test("识别带 reason 的 AbortSignal / 对象", () => {
    const ac = new AbortController();
    ac.abort("user-cancel");
    expect(isAbortError(ac.signal)).toBe(true);
    expect(isAbortError({ reason: "timeout" })).toBe(true);
  });

  test("ABORT_REASONS 覆盖所有 abort 调用点（防漂移哨兵）", () => {
    // 凡 abortController.abort("xxx") 用到的 reason 都必须登记在 ABORT_REASONS，
    // 否则该 reason 的孤儿 rejection 会被当真故障导致进程退出。
    // 若新增/修改 abort reason，请同步更新 ABORT_REASONS 与本断言。
    // 现有 reason：user-cancel(app.ts onInterrupt)、timeout(session 超时)、
    // turn-timeout(单轮硬超时)、watchdog-timeout(loop.ts 看门狗)、
    // side-call-timeout(side-call-timeout.ts：auto-compact/context-collapse/recall/warmup)。
    // 转 string[] 断言:ABORT_REASONS 是 as const 字面量联合,直接 toEqual 会因
    // NoInfer 把期望数组收窄到该联合而报重载不匹配;比较值本身即可,不需比字面量类型。
    expect([...ABORT_REASONS].map(String).sort()).toEqual([
      "side-call-timeout",
      "timeout",
      "turn-timeout",
      "user-cancel",
      "watchdog-timeout",
    ]);
    for (const r of ABORT_REASONS) {
      expect(isAbortError(r)).toBe(true);
    }
  });

  test("非 abort 错误返回 false", () => {
    expect(isAbortError(new Error("503 Service Unavailable"))).toBe(false);
    // 非白名单的裸字符串不能被误判为 abort
    expect(isAbortError("random-error")).toBe(false);
    expect(isAbortError("network down")).toBe(false);
  });
});
