/**
 * 配置层：`availableModels[].compat` 从 settings.json 到进程级表的**真实入口**回归。
 *
 * 为什么单独一个文件、而不是并进 `llm/model-compat.test.ts`：那份的每个用例都自己
 * `setModelCompat(...)` 手动播种，于是**整份都绕过了真实入口** —— 实测把
 * `resolveCurrentModelConfig` 里的 `setModelCompat` 调用整行注释掉，那 40 个用例
 * 依然全绿。这正是本仓「测试全绿但绕过真实入口」那条教训的同一形态。
 *
 * 本文件只测两条真实入口，两条都做过变异自证（注释掉接线 → 用例转红）：
 *   1. `normalizeConfigKeys`：settings.json 的 compat 必须被带进 ModelConfig（手写字段列表，漏一个即静默丢弃）；
 *   2. `resolveCurrentModelConfig`：它是启动解析与 `/model` 切换的共同咽喉，必须刷新进程级表。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Config } from "@sid-code/core/config/config.ts";
import {
  resolveCurrentModelConfig,
  normalizeConfigKeysForTest,
} from "@sid-code/core/config/config.ts";
import { lookupModelCompat, resetModelCompat } from "@sid-code/core/llm/model-compat.ts";
import { validateConfig } from "@sid-code/core/config/schema.ts";

beforeEach(() => resetModelCompat());
afterEach(() => resetModelCompat());

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    provider: "openai",
    model: "gw-deepseek",
    fallbackModel: "",
    anthropicKey: "",
    openaiKey: "k",
    baseURL: "https://gateway.internal/v1",
    maxTokens: 8192,
    availableModels: [],
    permissionMode: "default",
    skipPermissions: false,
    allowedTools: [],
    disallowedTools: [],
    yesMode: false,
    sessionId: "",
    continue: false,
    resume: "",
    print: false,
    outputFormat: "text",
    maxTurns: 0,
    systemPrompt: "",
    appendSystemPrompt: "",
    systemPromptFile: "",
    debug: false,
    debugLevel: "INFO",
    debugLogFile: "~/.sid-code/debug.log",
    hooks: [],
    mcpServers: {},
    ...over,
  } as unknown as Config;
}

describe("normalizeConfigKeys：settings.json 的 compat 必须带进 ModelConfig", () => {
  test("compat 原样透传（内部键归一化交给 model-compat.ts）", () => {
    const out = normalizeConfigKeysForTest({
      available_models: [
        {
          name: "gw-deepseek",
          model_id: "deepseek-chat",
          compat: { supports_thinking_toggle: false },
        },
      ],
    }) as any;
    expect(out.availableModels[0].compat).toEqual({ supports_thinking_toggle: false });
    // 同批字段不得回退（这一整块是手写列表，改一处容易碰掉邻居）
    expect(out.availableModels[0].modelId).toBe("deepseek-chat");
  });

  test("没配 compat → undefined（不臆造空对象）", () => {
    const out = normalizeConfigKeysForTest({
      available_models: [{ name: "plain" }],
    }) as any;
    expect(out.availableModels[0].compat).toBeUndefined();
  });
});

describe("resolveCurrentModelConfig：必须刷新进程级 compat 表", () => {
  test("解析后按别名查得到声明（这是全链唯一的真实注册点）", () => {
    const config = makeConfig({
      availableModels: [
        {
          name: "gw-deepseek",
          modelId: "deepseek-chat",
          compat: { supportsThinkingToggle: false },
        },
      ] as any,
    });
    resolveCurrentModelConfig(config);
    expect(lookupModelCompat("gw-deepseek")).toEqual({ supportsThinkingToggle: false });
  });

  test("snake_case 内部键经真实入口后同样生效", () => {
    const normalized = normalizeConfigKeysForTest({
      available_models: [
        { name: "gw-glm", compat: { tool_choice_auto_only: true, supports_max_effort: false } },
      ],
    }) as any;
    const config = makeConfig({ model: "gw-glm", availableModels: normalized.availableModels });
    resolveCurrentModelConfig(config);
    expect(lookupModelCompat("gw-glm")).toEqual({
      toolChoiceAutoOnly: true,
      supportsMaxEffort: false,
    });
  });

  test("切到无 compat 的配置必须把表清空（残留声明会让新配置按旧声明发字段）", () => {
    const withCompat = makeConfig({
      availableModels: [{ name: "gw-deepseek", compat: { supportsToolChoice: false } }] as any,
    });
    resolveCurrentModelConfig(withCompat);
    expect(lookupModelCompat("gw-deepseek")).toBeDefined();

    const without = makeConfig({
      availableModels: [{ name: "gw-deepseek" }] as any,
    });
    resolveCurrentModelConfig(without);
    expect(lookupModelCompat("gw-deepseek")).toBeUndefined();
  });

  test("availableModels 整个清空时也要清表（early-return 之前必须已刷新）", () => {
    resolveCurrentModelConfig(
      makeConfig({
        availableModels: [{ name: "gw-deepseek", compat: { supportsToolChoice: false } }] as any,
      }),
    );
    expect(lookupModelCompat("gw-deepseek")).toBeDefined();
    // availableModels 为空会在 setModelCompat 之后 early-return —— 顺序错了这条就红。
    resolveCurrentModelConfig(makeConfig({ availableModels: [] }));
    expect(lookupModelCompat("gw-deepseek")).toBeUndefined();
  });

  test("config.model 未命中任何条目时，其它条目的声明仍然注册", () => {
    // mc 未命中会 early-return，但表必须已经与当前列表一致（同 wire-model 的口径）。
    const config = makeConfig({
      model: "does-not-exist",
      availableModels: [{ name: "gw-deepseek", compat: { supportsToolChoice: false } }] as any,
    });
    resolveCurrentModelConfig(config);
    expect(lookupModelCompat("gw-deepseek")).toEqual({ supportsToolChoice: false });
  });

  test("脏 compat 不阻塞启动（loadConfig 链上抛出即进程起不来）", () => {
    const config = makeConfig({
      availableModels: [
        { name: "a", compat: "yes" },
        { name: "b", compat: { supportsToolChoice: "maybe" } },
        { name: "c", compat: 42 },
      ] as any,
    });
    expect(() => resolveCurrentModelConfig(config)).not.toThrow();
    expect(lookupModelCompat("a")).toBeUndefined();
    expect(lookupModelCompat("b")).toBeUndefined();
    expect(lookupModelCompat("c")).toBeUndefined();
  });
});

describe("schema 校验：脏 compat 出可读告警（不是静默丢弃）", () => {
  function warningsFor(models: unknown[]): string[] {
    const res = validateConfig(makeConfig({ availableModels: models as any }));
    return res.warnings.map((w) => w.message);
  }

  test("compat 整个类型错 → 点名说整块被忽略", () => {
    const msgs = warningsFor([{ name: "a", compat: "yes" }]);
    expect(msgs.some((m) => m.includes("compat 必须是对象") && m.includes("string"))).toBe(true);
  });

  test("未知字段 → 点名该字段并列出可用字段", () => {
    const msgs = warningsFor([{ name: "a", compat: { supportsTelepathy: true } }]);
    expect(msgs.some((m) => m.includes("supportsTelepathy") && m.includes("已忽略"))).toBe(true);
  });

  test("值不是布尔 → 点名该字段（含带引号的 'false' 这个最常见的坑）", () => {
    const msgs = warningsFor([{ name: "a", compat: { supports_tool_choice: "false" } }]);
    expect(
      msgs.some((m) => m.includes("compat.supports_tool_choice") && m.includes("布尔值")),
    ).toBe(true);
  });

  test("合法 compat 不产生任何 compat 相关告警（避免告警疲劳）", () => {
    const msgs = warningsFor([
      { name: "a", compat: { supportsToolChoice: false, supports_max_effort: true } },
    ]);
    expect(msgs.filter((m) => m.includes("compat"))).toEqual([]);
  });

  test("没配 compat 的条目不触发任何 compat 告警", () => {
    expect(warningsFor([{ name: "a" }]).filter((m) => m.includes("compat"))).toEqual([]);
  });
});
