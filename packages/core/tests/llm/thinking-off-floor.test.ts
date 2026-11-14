/**
 * 「关思考」在关不掉思考的模型上必须落到该模型**最低档**（2026-11-13 恒思考排查）。
 *
 * ## 事故形态
 *
 * `/think off` 与全部 side-call（压缩 / 目标评估 / 工具分类 / 记忆召回）都表达成
 * `thinking.enabled = false`。对恒思考模型，各层此前只做到「别发会 400 的值」：
 *
 * - side-call 什么都不发 → 服务端按**自己的默认档**跑；GLM-5.3 / Kimi K3 默认 `max`，
 *   于是**用户想省，结果比不敲更贵**；
 * - 无 `thinking.type` 开关字段的族（Kimi / Grok / o 系列）连「降级」都没有，`off` 直接被忽略；
 * - Anthropic 恒思考族的「关也按低 effort 下发」只写在注释里，代码里从未实现。
 *
 * 正确语义由两只官方文档共同给出：**开着思考，把强度压到最低档**
 * （GLM 迁移建议 `off → low`；Anthropic 恒思考 400 报错文本写
 * 「Use thinking.type.adaptive and output_config.effort」）。
 *
 * ## 本文件锁六件事
 *
 * 1. 判定入口：正例（恒思考 + 有档位表）落到 `low`；能关 / 无数据 → `undefined`（不猜）
 * 2. 门禁：判定入口**不出现任何模型名字面量**（规则进代码、模型事实进数据）
 * 3. 门禁：每个 `thinkingMode:"always-on"` 条目都必须登记 `reasoningEffortValues`
 *    （只补一半会让 `/think off` 静默退回「什么都不发」，与修复前一样）
 * 4. OpenAI 线格式：GLM 关思考 → `enabled + low`；无开关字段族 → 只发 `reasoning_effort: low`
 * 5. `off` 覆盖用户显式档位（`/think off` + `/effort max` → 实发 low）—— 这是刻意的
 * 6. Anthropic 线格式：恒思考 → `adaptive + low`（**不是** manual `budget_tokens`）；
 *    能关的族仍发 `disabled`
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import { SIDE_CALL_NO_THINK } from "@sid-code/core/llm/side-call-timeout.ts";
import { setModelCompat } from "@sid-code/core/llm/model-compat.ts";
import { isThinkingAlwaysOn } from "@sid-code/core/llm/dialect/catalog.ts";
import { thinkingOffEffortFloor } from "@sid-code/core/llm/dialect/thinking-off-floor.ts";
import { getRegistryEntries } from "@sid-code/core/llm/model-registry.ts";
import { buildThinkingWire } from "@sid-code/core/llm/anthropic.ts";
import {
  resolveEffortCapability,
  getDisplayedEffort,
  resolveThinking,
} from "@sid-code/core/llm/effort.ts";
import {
  __resetCapabilityCacheForTest,
  __sanitizeEntryForTest,
} from "@sid-code/core/llm/model-capabilities.ts";
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

function cap(model: string) {
  return resolveEffortCapability({ model, provider: "openai", baseURL: "https://gw.example/v1" });
}

let savedConfigDir: string | undefined;
let tmpHome: string;

beforeEach(() => {
  // 落盘隔离（CONTRIBUTING「测试约定」）：本文件 import 了 `model-capabilities.ts`，
  // 会被 `model-capabilities-persist-guard.test.ts` 的动态清单扫进去；而它调的
  // `resolveEffortCapability` 会读能力缓存，消费链上存在写盘。不显式重定向就会写进
  // 用户真实 `~/.sid-code/`（preload 兜底不替代显式隔离）。
  savedConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-thinking-off-floor-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  // 隔离真实能力缓存：本机同步过模型目录后，kimi-k3 等会从缓存读到档位表，
  // 让「注册表数据驱动」的断言变成环境依赖。
  __resetCapabilityCacheForTest({});
});

afterEach(() => {
  // 存/恢复原值，不要无条件 delete：bun test 同批多文件跑在同一进程，
  // 直接删会把 preload 的兜底一起抹掉。
  if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
  // compat 是进程级全局表，同批多文件共享：清空避免泄漏进其它文件。
  setModelCompat([]);
});

describe("① 判定入口：关思考 → 该模型最低档", () => {
  test("恒思考 + 有档位表 → low（各族都走同一个入口）", () => {
    // 覆盖四只族：GLM（type-enum 开关）、Anthropic（adaptive）、Kimi（unknown）、o 系列
    for (const model of ["glm-5.3", "claude-opus-5-5", "kimi-k3", "o3-mini", "grok-4.7"]) {
      expect(thinkingOffEffortFloor(model), `${model} 应落到 low`).toBe("low");
    }
  });

  test("网关改名 / 日期快照名也能命中（模糊查找，用户不必配 compat）", () => {
    expect(thinkingOffEffortFloor("origin-glm-5.3")).toBe("low");
    expect(thinkingOffEffortFloor("glm-5.3-0815")).toBe("low");
  });

  test("能关思考的模型不兜底（关就该发 disabled，不能被改成「低档思考」）", () => {
    for (const model of ["glm-5.2", "deepseek-v4", "grok-4.3", "claude-haiku-5-5", ""]) {
      expect(thinkingOffEffortFloor(model), `${model} 不应兜底`).toBeUndefined();
    }
  });

  test("compat 声明恒思考但注册表没档位表 → 不猜（宁可维持旧行为）", () => {
    setModelCompat([{ name: "gw-custom", compat: { thinkingAlwaysOn: true } }] as any);
    // 未登记档位表：不知道最低档是哪个，发一个模型不认的 effort 是确定 400。
    expect(thinkingOffEffortFloor("gw-custom")).toBeUndefined();
  });

  test("compat 声明不支持 reasoning_effort → 不兜底（运行时事实优先于模型属性）", () => {
    setModelCompat([{ name: "glm-5.3", compat: { supportsReasoningEffort: false } }] as any);
    // 走真实链路：capability 层会把 compat 传给判定入口（生产三处调用方都这么传）。
    expect(cap("glm-5.3").thinkingOffFloor).toBeUndefined();
    // 入口本身是纯函数，compat 由调用方给：不给就用「按名推导」，这是刻意的（无全局副作用）。
    expect(thinkingOffEffortFloor("glm-5.3", { supportsReasoningEffort: false })).toBeUndefined();
  });
});

describe("② 门禁：规则在代码、模型事实在数据", () => {
  test("判定入口不含任何模型名字面量（新增恒思考模型只加数据，不改代码）", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/llm/dialect/thinking-off-floor.ts"),
      "utf8",
    );
    // 先去掉注释：文件头刻意写了 GLM / Anthropic 的事故背景，那是说明不是判据。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\b(glm|kimi|claude|grok|deepseek|gpt|qwen|o[0-9])/i);
  });

  test("每个 always-on 条目都登记了档位表（只补一半会静默退回修复前的行为）", () => {
    const alwaysOn = getRegistryEntries().filter(([, e]) => e.thinkingMode === "always-on");
    // 防「选了个空集然后全绿」：清单为空时下面的循环不执行，断言必须自己兜底。
    expect(alwaysOn.length).toBeGreaterThanOrEqual(5);
    for (const [name, entry] of alwaysOn) {
      expect(entry.reasoningEffortValues, `${name} 声明了 always-on 却没有档位表`).toBeDefined();
      expect(entry.reasoningEffortValues!.length, `${name} 档位表为空`).toBeGreaterThan(0);
      expect(entry.reasoningEffortValues, `${name} 档位表缺少 low`).toContain("low");
    }
  });

  test("always-on 与 isThinkingAlwaysOn 同源（两处判定不得分叉）", () => {
    for (const [name, entry] of getRegistryEntries()) {
      expect(isThinkingAlwaysOn(name), `${name} 判定与注册表不一致`).toBe(
        entry.thinkingMode === "always-on",
      );
    }
  });
});

describe("③ OpenAI 线格式：GLM 关思考 → enabled + 最低档", () => {
  test("side-call 关思考：不再是「什么都不发」（那等于服务端默认 max）", () => {
    const body = wireBody("glm-5.3", SIDE_CALL_NO_THINK);
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("low");
  });

  test("带版本后缀的 glm-5.3-flash 同样兜底", () => {
    const body = wireBody("glm-5.3-flash", SIDE_CALL_NO_THINK);
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("low");
  });

  test("`off` 覆盖用户显式档位：/think off + /effort max → 实发 low", () => {
    const body = wireBody("glm-5.3", { enabled: false, budgetTokens: 0 }, "max");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("low");
  });

  test("开思考时仍按用户档位下发（兜底不得污染 on 路径）", () => {
    const body = wireBody("glm-5.3", { enabled: true, budgetTokens: 0 }, "max");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("max");
  });

  test("能关的模型不受影响：glm-5.2 / deepseek-v4 关思考仍发 disabled", () => {
    expect(wireBody("glm-5.2", SIDE_CALL_NO_THINK).thinking).toEqual({ type: "disabled" });
    expect(wireBody("deepseek-v4", SIDE_CALL_NO_THINK).thinking).toEqual({ type: "disabled" });
  });
});

describe("③ 无 thinking.type 开关字段的族：只发最低档", () => {
  test("Kimi K3 / Grok 4.7 / o3-mini 关思考 → reasoning_effort: low", () => {
    for (const model of ["kimi-k3", "grok-4.7", "o3-mini"]) {
      const body = wireBody(model, SIDE_CALL_NO_THINK);
      expect(body.reasoning_effort, `${model}`).toBe("low");
      // 这些族本来就没有 thinking 字段，兜底不得凭空造一个
      expect("thinking" in body, `${model} 不应下发 thinking`).toBe(false);
    }
  });

  test("未登记的旧模型（grok-4.3）关思考 → 不发 effort（不变）", () => {
    expect(wireBody("grok-4.3", SIDE_CALL_NO_THINK).reasoning_effort).toBeUndefined();
  });
});

describe("④ Anthropic 线格式：恒思考 → adaptive + 最低档", () => {
  const sendParams = (thinking: SendParams["thinking"], effort?: string): SendParams => ({
    model: "claude-opus-5-5",
    wireModel: "claude-opus-5-5",
    messages: [],
    maxTokens: 1024,
    thinking,
    ...(effort ? { outputConfig: { effort: effort as any } } : {}),
  });

  test("恒思考 + 关思考 → adaptive，并带出最低档（不是 disabled、也不是 manual budget）", () => {
    const wire = buildThinkingWire(
      sendParams({ enabled: false, budgetTokens: 0 }),
      "claude-opus-5-5",
    );
    expect(wire.param).toEqual({ thinking: { type: "adaptive" } });
    expect(wire.effortFloor).toBe("low");
    // dropEffort 必须为 false：正是要让最低档发出去
    expect(wire.dropEffort).toBe(false);
    // ⚠ 不能是 manual 的 budget_tokens（side-call 没有 outputConfig.thinkingType，会静默退回 manual）
    expect(wire.param).not.toHaveProperty("thinking.budget_tokens");
  });

  test("能关的 Anthropic 模型仍发 disabled，dropEffort（不变）", () => {
    // claude-opus-5 不是 always-on，thinkingOmitMeans 语义决定发不发 disabled
    const wire = buildThinkingWire(
      sendParams({ enabled: false, budgetTokens: 0 }),
      "claude-opus-5",
    );
    expect(wire.param).toEqual({ thinking: { type: "disabled" } });
    expect(wire.dropEffort).toBe(true);
  });

  test("开思考时照旧走 buildThinkingParam，effortFloor 不参与", () => {
    const wire = buildThinkingWire(
      sendParams({ enabled: true, budgetTokens: 5000 }),
      "claude-opus-5-5",
    );
    expect(wire.effortFloor).toBeUndefined();
  });
});

describe("⑤ capability 层：applier 与展示都读同一个兜底档", () => {
  test("locked-on + 档位表 → thinkingOffFloor 挂上，applier 实发最低档", () => {
    const c = cap("glm-5.3");
    expect(c.thinkingControl).toBe("locked-on");
    expect(c.thinkingOffFloor).toBe("low");

    const params: SendParams = {
      model: "glm-5.3",
      wireModel: "glm-5.3",
      messages: [],
      maxTokens: 0,
    };
    // 用户选 max + 思考关 → 实发 low（off 是上游决定）
    c.applyToSendParams(params, "max", false);
    expect(params.reasoningEffort).toBe("low");
    expect(params.thinking?.enabled).toBe(true);
  });

  test("思考开时 applier 仍按用户档位（包装层只拦 thinking=false）", () => {
    const c = cap("glm-5.3");
    const params: SendParams = {
      model: "glm-5.3",
      wireModel: "glm-5.3",
      messages: [],
      maxTokens: 0,
    };
    c.applyToSendParams(params, "max", true);
    expect(params.reasoningEffort).toBe("max");
  });

  test("展示层：locked-on + 意图 off → 显示实发档 low，不是用户选的 max", () => {
    const c = cap("glm-5.3");
    const offIntent = resolveThinking(c, "off", null);
    expect(offIntent).toBe(false);
    expect(getDisplayedEffort(c, "max", null, offIntent)).toBe("low");
    // 意图 on / auto 时不兜底，仍显示所选档映射结果
    expect(getDisplayedEffort(c, "max", null, true)).toBe("max");
  });

  test("无兜底档的模型：展示与下发都不变（负向对照）", () => {
    const c = cap("glm-5.2");
    expect(c.thinkingOffFloor).toBeUndefined();
    const offIntent = resolveThinking(c, "off", null);
    expect(getDisplayedEffort(c, "max", null, offIntent)).toBe("max");
  });

  test("Kimi K3 从 none 变 locked-on（没有开关字段 ≠ 没有思考）", () => {
    const c = cap("kimi-k3");
    expect(c.thinkingControl).toBe("locked-on");
    expect(c.thinkingOffFloor).toBe("low");
    // 它是无开关字段的族：不支持 thinking.type，但档位照样能压到最低
    expect(c.supportsThinkingToggle).toBe(false);
  });
});
