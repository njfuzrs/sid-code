/**
 * PR3 回归：恒思考模型不得收到 `thinking:{type:"disabled"}`
 *
 * 事故背景（会话 `20260817-135824-fcf863e1`，GLM-5.3 经公司网关）：
 * 全部 side-call 无条件套用 `SIDE_CALL_NO_THINK = { enabled: false }`，
 * 在 GLM 线上被序列化成 `thinking:{type:"disabled"}` → GLM-5.3 恒思考、服务端 400
 * 「该模型始终思考，不支持关闭思考」→ 该错误分类为 `TerminalError("invalid_request")`
 * → **零重试**直接判"主 Provider 失败且无可用 fallback"。实测 11 次真实请求全灭。
 *
 * ## 2026-11-13 起本文件的前提变了（旧版是「降级为不下发」）
 *
 * PR3 当时只做到「不发 `disabled`」——等价于让服务端按**它自己的默认档**跑。
 * GLM-5.3 / Kimi K3 的默认档是 `max`，于是 `/think off` 想省反而拉满（本次修复的病）。
 * 现在的正确形态是官方迁移建议的 **`enabled + 该模型最低档`**
 * （规则见 `dialect/thinking-off-floor.ts`）。本文件的期望同步改成新契约：
 *
 *   ① 恒思考模型 + 关思考 → `enabled + low`（**不是** disabled，也**不是**什么都不发）
 *   ② 恒思考模型 + 开思考 → 照常按用户档位下发（兜底不得污染 on 路径）
 *   ③ 非恒思考模型不受影响（负向对照：别把降级过度泛化）
 *   ④ compat 显式声明可覆盖内置名单（网关改名场景的唯一出口）
 *
 * 「什么都没登记」的情形（compat 只声明恒思考、注册表无档位表）仍维持不下发 —— 不知道
 * 最低档是哪个就不编，发一个模型不认的 effort 是确定 400。该分支由 ④ 覆盖。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import { SIDE_CALL_NO_THINK } from "@sid-code/core/llm/side-call-timeout.ts";
import {
  setModelCompat,
  normalizeModelCompat,
  MODEL_COMPAT_KEYS,
} from "@sid-code/core/llm/model-compat.ts";
import { isThinkingAlwaysOn } from "@sid-code/core/llm/dialect/catalog.ts";
import type { SendParams } from "@sid-code/core/llm/types.ts";

/** 直接跑生产序列化函数，拿到真实会发到线上的请求体片段 */
function wireBody(model: string, thinking: SendParams["thinking"], effort?: string): any {
  const provider = new OpenAIProvider("test-key", model, "https://gateway.example.com/v1");
  const body: any = {};
  (provider as any).applyDeepSeekThinking(
    body,
    { model, thinking, ...(effort ? { reasoningEffort: effort } : {}) },
    model,
  );
  return body;
}

describe("PR3 恒思考模型的 thinking 降级", () => {
  afterEach(() => {
    // 存/恢复语义：compat 是进程级全局表，跨测试文件共享。清空而非保留，
    // 避免本文件的声明泄漏进同批次其它测试（bun test 同进程跑多文件）。
    setModelCompat([]);
  });

  test("① glm-5.3 + side-call 关思考 → enabled + 最低档（改造前是 disabled 必 400，上一版是不发）", () => {
    const body = wireBody("glm-5.3", SIDE_CALL_NO_THINK);
    expect(body.thinking).toEqual({ type: "enabled" });
    // 关键：不是「不发」——不发等于服务端默认 max，用户想省反而更贵。
    expect(body.reasoning_effort).toBe("low");
  });

  test("① 变体：带版本后缀的 glm-5.3-flash 同样兜底", () => {
    const body = wireBody("glm-5.3-flash", SIDE_CALL_NO_THINK);
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("low");
  });

  test("② glm-5.3 + 主循环开思考 → 照常下发 enabled + 用户档位（别把能力一起关掉）", () => {
    const body = wireBody("glm-5.3", { enabled: true, budgetTokens: 0 }, "max");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("max");
  });

  test("③ 负向对照：glm-5.2 / deepseek 关思考仍下发 disabled（降级不得过度泛化）", () => {
    expect(wireBody("glm-5.2", SIDE_CALL_NO_THINK).thinking).toEqual({ type: "disabled" });
    expect(wireBody("deepseek-v4", SIDE_CALL_NO_THINK).thinking).toEqual({ type: "disabled" });
  });

  test("③ 负向对照：未登记档位表的相似名不会借走恒思考数据", () => {
    expect(isThinkingAlwaysOn("glm-5.3")).toBe(true);
    expect(isThinkingAlwaysOn("glm-5.3-flash")).toBe(true);
    // 模糊查找不命中 `glm-5.30`（它不是 5.3 的快照/改名形态）
    expect(isThinkingAlwaysOn("glm-5.30")).toBe(false);
    expect(isThinkingAlwaysOn("glm-5.2")).toBe(false);
    expect(isThinkingAlwaysOn("")).toBe(false);
  });

  test("④ compat thinking_always_on 覆盖内置名单（网关把模型改了名的唯一出口）", () => {
    // 该名字命中不了内置名单（也查不到档位表），靠用户显式声明生效。
    // 没有档位表 → 不知道最低档是哪个 → 维持「不下发」（不猜）。
    // 仍需是 Chat Completions 族才会走到这段装配，故取一个 deepseek 族的名字。
    setModelCompat([{ name: "deepseek-gw", compat: { thinkingAlwaysOn: true } }] as any);
    expect("thinking" in wireBody("deepseek-gw", SIDE_CALL_NO_THINK)).toBe(false);

    // 负向对照：同一个名字不声明 thinkingAlwaysOn 时照旧下发 disabled ——
    // 证明上面那行是**声明生效**，不是这个名字恰好走了别的降级分支。
    setModelCompat([]);
    expect(wireBody("deepseek-gw", SIDE_CALL_NO_THINK).thinking).toEqual({ type: "disabled" });
  });

  test("④ compat 归一化认 snake_case，且新键已登记进闭集清单", () => {
    expect(normalizeModelCompat({ thinking_always_on: true })).toEqual({ thinkingAlwaysOn: true });
    expect(normalizeModelCompat({ thinkingAlwaysOn: true })).toEqual({ thinkingAlwaysOn: true });
    // 防漂移：键没登记进 MODEL_COMPAT_KEYS 就会被 normalize 静默丢掉，
    // 用户配了却不生效且无任何提示 —— 本仓「手写字段列表漏项」的同型。
    expect(MODEL_COMPAT_KEYS).toContain("thinkingAlwaysOn");
  });
});
