/**
 * 回归门禁：网关 / 大模型的**真实**报错信息必须能到达 TUI，而不是一律退化成
 * 通用「运行错误」。
 *
 * 事故来源：轨迹 20260905-215535-664d3239。RetryTelemetry 里逐条记着
 * 「当前分组上游负载已饱和，请稍后再试 (request id: …)」+ `reopenReason: "rate_limit"`
 * 共 6 次重试，而 errors.jsonl / TurnError 只留下一句
 * 「LLM 错误: 主模型请求失败，已终止本轮。可重新发送消息重试，或用 /model 切换模型。」——
 * 用户既看不到 429，也无从判断该等一等还是该换模型。
 *
 * 本文件的每条断言都对应一个具体缺陷，且都做过**变异自证**（把修复改回旧写法会红）：
 * 详见各 test 的注释。
 */

import { describe, test, expect } from "bun:test";
import {
  inferErrorCode,
  codeFromStructured,
  lookupErrorMessage,
} from "@sid-code/core/llm/error-messages.ts";
import { LLMStreamError, hasBoundaryDigits } from "@sid-code/core/llm/errors.ts";

describe("缺陷1 — 网关中文措辞此前一个都识别不出（返回 undefined → 通用「运行错误」）", () => {
  // 变异自证：删掉 inferErrorCode 里的「负载已饱和」分支 → 本条返回 undefined 而红。
  test("轨迹里的原句识别为 rate_limit", () => {
    const real =
      "当前分组上游负载已饱和，请稍后再试 (request id: 2026090519422733007594196e93ae3ImkHCOsN)";
    expect(inferErrorCode(real)).toBe("rate_limit");
    // 用户能看到的标题必须是「限流」而不是通用兜底。
    expect(lookupErrorMessage(real).title).not.toBe("运行错误");
    expect(lookupErrorMessage(real).title).toContain("限流");
  });

  test("402 / 余额不足 归入 quota_exhausted（deepseek 欠费实测走这条）", () => {
    expect(inferErrorCode("402 当前分组余额不足，请充值后再试")).toBe("quota_exhausted");
    expect(inferErrorCode("Insufficient Balance")).toBe("quota_exhausted");
    expect(lookupErrorMessage("Insufficient Balance").title).not.toBe("运行错误");
  });

  test("其它常见网关措辞", () => {
    expect(inferErrorCode("请求过于频繁，请稍后再试")).toBe("rate_limit");
    expect(inferErrorCode("Too Many Requests")).toBe("rate_limit");
  });
});

describe("缺陷2 — 状态码用裸 includes 判定会误判（数字边界）", () => {
  // 变异自证：把 hasBoundaryDigits(lower,"502") 改回 lower.includes("502")
  // → "gateway trace 5024" 命中 server_error 而红。
  test("被更长数字串吞掉的状态码不算命中", () => {
    expect(inferErrorCode("gateway trace 5024 内部错误")).toBeUndefined();
    expect(inferErrorCode("耗时 4001ms 后失败")).toBeUndefined();
    expect(
      inferErrorCode("上游错误 (request id: 20260905194229773007594196e93ae3)"),
    ).toBeUndefined();
  });

  test("合法状态码写法仍然命中（不能为了防误判把真信号也挡掉）", () => {
    expect(inferErrorCode("HTTP 429: Too Many Requests")).toBe("rate_limit");
    expect(inferErrorCode("502 Upstream connection error: Server disconnected")).toBe(
      "server_error",
    );
    expect(inferErrorCode("code=400 invalid parameter")).toBe("invalid_request");
  });

  test("两处判据共用同一个 hasBoundaryDigits 实现（各写一份就会只修一边）", () => {
    expect(hasBoundaryDigits("trace 5024", "502")).toBe(false);
    expect(hasBoundaryDigits("http 502", "502")).toBe(true);
  });
});

describe("缺陷3 — 结构化 statusCode/type 在抛出点被丢弃，UI 只能从文本猜", () => {
  test("LLMStreamError 保留结构化字段，且 message 与旧行为逐字节一致", () => {
    const e = new LLMStreamError("LLM 错误: 当前分组上游负载已饱和", 429, "rate_limit_error", true);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("LLM 错误: 当前分组上游负载已饱和");
    expect(e.statusCode).toBe(429);
    expect(e.errorType).toBe("rate_limit_error");
    expect(e.streamLevel).toBe(true);
  });

  // 这条是"猜不出来"的兜底保险：即使文本关键词表将来又漏一种措辞，
  // 只要上游给了状态码，分类仍然正确。
  test("上游给了状态码就不必猜——哪怕文本完全不含关键词", () => {
    expect(codeFromStructured(429, undefined)).toBe("rate_limit");
    expect(codeFromStructured(402, undefined)).toBe("quota_exhausted");
    expect(codeFromStructured(401, undefined)).toBe("auth_failed");
    expect(codeFromStructured(404, undefined)).toBe("model_not_found");
    expect(codeFromStructured(529, undefined)).toBe("overloaded");
    expect(codeFromStructured(502, undefined)).toBe("server_error");
  });

  test("error.type 比状态码更具体，优先生效", () => {
    // 同一个 400，type 决定它是参数错还是内容策略拒答。
    expect(codeFromStructured(400, "content_policy_violation")).toBe("content_policy");
    expect(codeFromStructured(400, undefined)).toBe("invalid_request");
    expect(codeFromStructured(500, "overloaded_error")).toBe("overloaded");
  });

  test("结构化信息不足时返回 undefined（调用方回落文本推断，不得当成「无错误」）", () => {
    expect(codeFromStructured(undefined, undefined)).toBeUndefined();
    expect(codeFromStructured(418, "")).toBeUndefined();
    // 回落链路：结构化拿不到 → 文本仍能救回来。
    const msg = "当前分组上游负载已饱和";
    expect(codeFromStructured(undefined, undefined) ?? inferErrorCode(msg)).toBe("rate_limit");
  });

  test("每个 codeFromStructured 的返回码都在文案表里有条目（否则面板又退化成通用兜底）", () => {
    const codes = [
      codeFromStructured(401),
      codeFromStructured(402),
      codeFromStructured(404),
      codeFromStructured(408),
      codeFromStructured(409),
      codeFromStructured(400),
      codeFromStructured(429),
      codeFromStructured(503),
      codeFromStructured(500),
      codeFromStructured(400, "content_policy_violation"),
      codeFromStructured(500, "overloaded_error"),
    ];
    for (const c of codes) {
      expect(c).toBeTruthy();
      // 用 code 直查必须命中，不能落到 "运行错误"。
      expect(lookupErrorMessage("任意文本", c!).title).not.toBe("运行错误");
    }
  });
});
