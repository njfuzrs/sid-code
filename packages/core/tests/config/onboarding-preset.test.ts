import { describe, test, expect } from "bun:test";
import { applyPresetApiKey } from "@sid-code/core/config/onboarding-preset.ts";
import teamDefaults from "../../../../scripts/team-defaults.template.json" with { type: "json" };

const PH = "__YOUR_API_KEY__";
const tpl = () => structuredClone(teamDefaults) as Record<string, any>;
const keyOf = (list: any[], name: string) => list.find((m) => m.name === name)?.apiKey;

describe("applyPresetApiKey（首次引导选预置模型 → 只填 key）", () => {
  test("同端点的占位符条目一起回填，别家条目不动", () => {
    const p = applyPresetApiKey(tpl(), "deepseek-v4-pro", "sk-ds");
    const list = p.availableModels as any[];
    expect(keyOf(list, "deepseek-v4-pro")).toBe("sk-ds");
    expect(keyOf(list, "deepseek-flash")).toBe("sk-ds");
    expect(keyOf(list, "kimi-k3")).toBe(PH);
    expect(list.length).toBe(tpl().availableModels.length);
    expect(p.model).toBe("deepseek-v4-pro");
  });

  test("选模板默认厂商时 fallback / 子代理都已可用 ⇒ 不改写", () => {
    const p = applyPresetApiKey(tpl(), "deepseek-v4-pro", "sk-ds");
    expect(p.fallbackModel).toBeUndefined();
    expect(p.subAgentModels).toBeUndefined();
  });

  test("选别家：指向没 key 模型的 fallback 清空、子代理改到选中模型", () => {
    const p = applyPresetApiKey(tpl(), "kimi-k3", "sk-kimi");
    expect(p.fallbackModel).toBe("");
    expect(p.subAgentModels).toEqual({ default: "kimi-k3", task: "kimi-k3", verify: "kimi-k3" });
  });

  test("fallback 指向没 key 的模型时，优先改成同端点另一个已有 key 的模型", () => {
    const raw = tpl();
    raw.fallbackModel = "claude-opus-5-5";
    const p = applyPresetApiKey(raw, "deepseek-v4-pro", "sk-ds");
    expect(p.fallbackModel).toBe("deepseek-flash");
  });

  test("用户已填过的真 key 不被覆盖", () => {
    const raw = tpl();
    raw.availableModels.find((m: any) => m.name === "deepseek-flash").apiKey = "sk-old";
    const p = applyPresetApiKey(raw, "deepseek-v4-pro", "sk-new");
    expect(keyOf(p.availableModels as any[], "deepseek-flash")).toBe("sk-old");
  });

  test("snake_case 写法（api_key / base_url）保持原字段名", () => {
    const raw = {
      model: "a",
      availableModels: [
        { name: "a", provider: "openai", base_url: "https://x/v1", api_key: PH },
        { name: "b", provider: "openai", base_url: "https://x/v1", api_key: PH },
      ],
    };
    const list = applyPresetApiKey(raw, "b", "sk-b").availableModels as any[];
    expect(list[0]).toEqual({
      name: "a",
      provider: "openai",
      base_url: "https://x/v1",
      api_key: "sk-b",
    });
    expect("apiKey" in list[1]).toBe(false);
  });

  test("选中的模型不在清单里 ⇒ 抛错（调用方提示用户手动编辑）", () => {
    expect(() => applyPresetApiKey(tpl(), "nope", "k")).toThrow();
  });
});
