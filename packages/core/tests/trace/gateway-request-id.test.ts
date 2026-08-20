/**
 * PR8 回归：`raw.jsonl` 保留网关 request-id
 *
 * 缺陷（§4.1）：`raw.jsonl` 里每条记录的 `response` 只有 `content` / `stop_reason` /
 * `usage`，**没有任何 HTTP 响应头**。一旦怀疑"是网关自己在排队/限流/丢包"，
 * 手上没有任何标识可以拿去找网关方核对具体是哪一次请求 —— 只能拿时间戳让对方
 * 全量捞日志，实际操作中等于查不了。
 *
 * 前置门禁已实测通过（2026-08-19，两族网关各抓一次响应头）：
 *   uniapi（openai + anthropic）→ `x-oneapi-request-id`
 *   ppchat（anthropic）        → `x-shellapi-request-id`
 * 两个都是 One-API 系分叉的自有命名，**不是**厂商标准头 —— 所以候选清单必须
 * 同时覆盖网关头、厂商官方头、CDN 标识三类。
 *
 * fix_type: case_design
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  extractRequestId,
  recordRequestId,
  takeLastRequestId,
  __resetRequestIdForTest,
} from "@sid-code/core/api/request-id.ts";

afterEach(() => {
  __resetRequestIdForTest();
});

describe("PR8 — extractRequestId 覆盖实测存在的网关头", () => {
  test("uniapi：x-oneapi-request-id", () => {
    const id = extractRequestId({ "x-oneapi-request-id": "202608191725212894588638268d9d6k" });
    expect(id).toEqual({
      header: "x-oneapi-request-id",
      value: "202608191725212894588638268d9d6k",
    });
  });

  test("ppchat：x-shellapi-request-id", () => {
    const id = extractRequestId({ "x-shellapi-request-id": "2026082001254269571978117037044" });
    expect(id?.header).toBe("x-shellapi-request-id");
  });

  test("厂商官方头（直连端点用）", () => {
    expect(extractRequestId({ "openai-request-id": "req_abc" })?.value).toBe("req_abc");
    expect(extractRequestId({ "anthropic-request-id": "req_xyz" })?.value).toBe("req_xyz");
    expect(extractRequestId({ "x-request-id": "req_123" })?.value).toBe("req_123");
  });

  test("Headers 实例与大小写不一的 record 都能读", () => {
    const h = new Headers({ "X-OneAPI-Request-Id": "abc" });
    expect(extractRequestId(h)?.value).toBe("abc");
    expect(extractRequestId({ "X-ONEAPI-REQUEST-ID": "abc" })?.value).toBe("abc");
  });

  test("头名必须与值一起返回（否则分不清该找哪一方对账）", () => {
    const id = extractRequestId({ "cf-ray": "abc-SJC" });
    expect(id?.header).toBe("cf-ray");
    // 这就是为什么返回的不是裸字符串：本仓两族网关的头名不同，
    // 只留值时无法回答"这个 id 拿去找谁"。
  });

  test("优先级：网关自有头 > 厂商官方头 > CDN 标识", () => {
    const id = extractRequestId({
      "cf-ray": "cdn",
      "x-request-id": "vendor",
      "x-oneapi-request-id": "gateway",
    });
    // 排查"是不是网关在排队"要找的正是网关侧的 id。
    expect(id?.value).toBe("gateway");
  });

  test("负向对照：一个都没下发 → undefined（不是空串）", () => {
    expect(extractRequestId({ "content-type": "text/event-stream" })).toBeUndefined();
    // 空白值也当没有：填一个 "" 进 raw.jsonl 会让分析侧误以为"采到了但网关给了空"。
    expect(extractRequestId({ "x-request-id": "   " })).toBeUndefined();
  });

  test("不做前缀通配：非清单内的 *-request-id 不误收", () => {
    // 收错比没收更坏 —— 对方按一个不存在的 id 查，会得出"没有这次请求"的错误结论。
    expect(extractRequestId({ "x-myapp-internal-request-id": "nope" })).toBeUndefined();
  });

  test("超长值截断而非丢弃（前缀仍可对账）", () => {
    const long = "x".repeat(500);
    const id = extractRequestId({ "x-request-id": long });
    expect(id).toBeDefined();
    expect(id!.value.length).toBeLessThanOrEqual(200);
  });
});

describe("PR8 — 进程级暂存：读一次即清", () => {
  test("record → take 拿到值", () => {
    recordRequestId({ "x-oneapi-request-id": "id-1" });
    expect(takeLastRequestId()?.value).toBe("id-1");
  });

  test("取走即清：第二次 take 是 undefined", () => {
    recordRequestId({ "x-oneapi-request-id": "id-1" });
    takeLastRequestId();
    // 不清的话，下一轮若没有 id，采集侧会把**上一轮**的 id 写进 raw.jsonl ——
    // 陈旧值当本轮事实，比缺字段更坏（拿着错 id 去找网关方对账）。
    expect(takeLastRequestId()).toBeUndefined();
  });

  test("覆盖语义：重试/重开流后以最后一次为准", () => {
    recordRequestId({ "x-oneapi-request-id": "attempt-1" });
    recordRequestId({ "x-oneapi-request-id": "attempt-2" });
    // 产出最终响应的是后一次请求；前一次已作废。
    // 想追每次 attempt 的 id 看 events.jsonl 的 HttpConnected/AfterModelRaw。
    expect(takeLastRequestId()?.value).toBe("attempt-2");
  });

  test("响应头里没有 id 时不覆盖已有暂存", () => {
    recordRequestId({ "x-oneapi-request-id": "id-1" });
    recordRequestId({ "content-type": "application/json" });
    // 一次没有 id 的响应头不该把已记到的 id 抹掉（比如 SDK 分两次给头的场景）。
    expect(takeLastRequestId()?.value).toBe("id-1");
  });
});

describe("PR8 — 三条 provider 路径都记（形态断言）", () => {
  const read = (p: string) =>
    require("fs").readFileSync(require("path").join(import.meta.dir, "../../src", p), "utf8");

  test("openai 两条路径 + anthropic 一条都调用 recordRequestId", () => {
    const openaiSrc = read("llm/openai.ts");
    const anthropicSrc = read("llm/anthropic.ts");
    // Chat Completions + Responses = 2 处
    const openaiHits = openaiSrc.split("recordRequestId(response.headers)").length - 1;
    expect(openaiHits).toBe(2);
    expect(anthropicSrc).toContain("recordRequestId(response.headers)");
  });

  test("采集侧取走并写进 raw.jsonl 的 response（不是只落 events）", () => {
    expect(read("query/loop.ts")).toContain("gateway_request_id: takeLastRequestId()");
    const collector = read("trace/collector.ts");
    expect(collector).toContain("gateway_request_id: resp.gateway_request_id");
    // events.jsonl 也落一份：raw.jsonl 可被 SID_CODE_TRACE_NO_RAW=1 关掉，
    // 而"怀疑网关排队"恰恰是最需要它、又最可能已经关了 raw 的场景。
    expect(collector).toContain("gateway_request_id_header");
  });
});
