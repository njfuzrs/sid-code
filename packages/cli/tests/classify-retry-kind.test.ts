/**
 * classifyRetryKind 单测 — CM3/CM4 重试种类推断
 */

import { test, expect, describe } from "bun:test";
import { classifyRetryKind } from "@sid-code/cli/app.ts";

describe("classifyRetryKind", () => {
  test("限流类错误 → rate_limit", () => {
    expect(classifyRetryKind("HTTP 429 Too Many Requests")).toBe("rate_limit");
    expect(classifyRetryKind("rate limit exceeded")).toBe("rate_limit");
    expect(classifyRetryKind("quota exceeded")).toBe("rate_limit");
  });

  test("过载类错误 → overloaded", () => {
    expect(classifyRetryKind("HTTP 529 overloaded")).toBe("overloaded");
    expect(classifyRetryKind("503 Service Unavailable")).toBe("overloaded");
    expect(classifyRetryKind("server at capacity")).toBe("overloaded");
  });

  test("其它错误 → retry", () => {
    expect(classifyRetryKind("ECONNRESET")).toBe("retry");
    expect(classifyRetryKind("timeout")).toBe("retry");
    expect(classifyRetryKind("")).toBe("retry");
  });
});

/**
 * 2026-09-06：classifyRetryKind 改为复用 inferErrorCode（删掉自带的一套正则）。
 *
 * 缺陷本体是"两套平行判据"：这里原先写 `/429|rate.?limit|quota|too many requests/`，
 * 与 error-messages.ts 的关键词表各自演进，于是同一个错误在**提示条语气**和
 * **错误面板标题**上给出不同结论。两个方向都实测错过（见函数注释）。
 */
describe("单一事实源：与 inferErrorCode 同口径", () => {
  test("网关中文限流措辞 → rate_limit（此前落到 retry，CM4 建议不出现）", () => {
    // 变异自证：把函数改回旧正则 → 本条返回 retry 而红。
    // 影响是实的：落到 retry 时，RetryStatus 那句「用 /model 切换模型 / 查配额」
    // 不渲染，而限流恰恰是最需要这个建议的场景。
    expect(
      classifyRetryKind("当前分组上游负载已饱和，请稍后再试 (request id: 2026090519422733007594)"),
    ).toBe("rate_limit");
  });

  test("裸数字子串不再误判（4291ms 里的 429）", () => {
    // 旧正则 /429/ 会命中 → 一个超时被说成「触发限流」，语气与真实故障相反。
    expect(classifyRetryKind("耗时 4291ms 后失败")).toBe("retry");
    expect(classifyRetryKind("上游错误 (request id: 20260905194229773007594196e93ae3)")).toBe(
      "retry",
    );
  });

  test("用量额度用尽按限流语气呈现（「换模型 / 查配额」才是该给的动作）", () => {
    expect(classifyRetryKind("You've hit your session limit · resets 3:45pm")).toBe("rate_limit");
    expect(classifyRetryKind("Credit balance is too low")).toBe("rate_limit");
  });

  test("官方过载文案 → overloaded", () => {
    expect(
      classifyRetryKind("API Error: Repeated 529 Overloaded errors. The API is at capacity"),
    ).toBe("overloaded");
  });

  test("「短期限流」不是用量到顶：按限流语气，且必须可自动消失", () => {
    // 官方文案带 "(not your usage limit)" —— 含 "usage limit" 子串却**明确否认**是配额问题。
    // 若被 usage_limit_reached 吃掉就成了终态错误：请求早已恢复而红卡永久挂着，
    // 正是本仓库修过一次的「限流卡片不消失」同形缺陷。
    expect(classifyRetryKind("API Error: Server is temporarily limiting requests")).toBe(
      "rate_limit",
    );
    expect(
      classifyRetryKind(
        "API Error: Server is temporarily limiting requests (not your usage limit)",
      ),
    ).toBe("rate_limit");
  });

  test("显式 429 优先于 capacity —— 限流语气才带「查配额」建议", () => {
    // 这条官方文案同时含 "429" 和 "capacity issue"，判序上 rate_limit 在 overloaded 之前。
    // 这是**刻意**的：上游明确回了 429 就是限流，capacity 只是它的解释性措辞。
    // （写这条是因为第一版把它错标成 overloaded —— 留档以免后人又改反。）
    expect(classifyRetryKind("API Error: Request rejected (429) · temporary capacity issue")).toBe(
      "rate_limit",
    );
  });
});
