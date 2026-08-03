/**
 * P2-1 /model 面板左右键调 effort：档位解析 + 按模型循环的纯逻辑测试
 *
 * 覆盖「档位与模型配对」这条主线：
 *   getSelectableEfforts   —— 每个模型真实可选的档位集合（不再是全量 5 档硬编码）
 *   cycleEffortForModel    —— 在该集合内循环，每按一次必有可见变化
 *   resolveDisplayedEffort —— 面板显示哪一档（auto 态取实际生效档）
 */
import { describe, test, expect } from "bun:test";
import { resolveDisplayedEffort } from "../../src/ui/components/ModelDialog.tsx";
import {
  getSelectableEfforts,
  cycleEffortForModel,
  resolveEffortCapability,
  type EffortCapability,
  type EffortLevel,
} from "../../src/llm/effort.ts";

const CAP: EffortCapability = {
  supportsEffort: true,
  supportsMaxEffort: true,
} as unknown as EffortCapability;

/** 取真实能力描述符（走 resolveEffortCapability，与运行时同源，不手搓假 cap） */
function capFor(model: string, provider: string, baseURL?: string): EffortCapability {
  return resolveEffortCapability({ model, provider, baseURL });
}

describe("getSelectableEfforts：档位集合与模型配对", () => {
  test("原生 Claude 走 budget_tokens，5 档各自对应不同预算，全部可选", () => {
    const cap = capFor("claude-opus-5", "anthropic", "https://code.ppchat.vip");
    expect(getSelectableEfforts(cap)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("GPT-5.x Responses 原生支持 5 档（含 xhigh）", () => {
    const cap = capFor("gpt-5.4", "openai", "https://gateway.example.com/v1");
    expect(getSelectableEfforts(cap)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("o-series 无 max 与 xhigh，只剩 3 档", () => {
    const cap = capFor("o3-mini", "openai", "https://api.openai.com/v1");
    expect(getSelectableEfforts(cap)).toEqual(["low", "medium", "high"]);
  });

  test("DeepSeek 线格式仅认 high/max，low/medium 会被钳制故不列出", () => {
    const cap = capFor("ali-deepseek-v4-pro", "openai", "https://gateway.example.com/v1");
    expect(getSelectableEfforts(cap)).toEqual(["high", "max"]);
  });

  test("GLM 支持 max 但 xhigh 被钳制，故为 4 档", () => {
    const cap = capFor("glm-5.2", "openai", "https://gateway.example.com/v1");
    expect(getSelectableEfforts(cap)).toEqual(["low", "medium", "high", "max"]);
  });

  test("不支持 effort 的模型返回空数组（UI 据此禁用切换）", () => {
    const noop: EffortCapability = {
      ...CAP,
      supportsEffort: false,
      applyToSendParams: () => {},
    } as unknown as EffortCapability;
    expect(getSelectableEfforts(noop)).toEqual([]);
  });

  test("档位集合恒为 low→max 升序（面板列表顺序稳定）", () => {
    const order: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
    for (const model of ["claude-opus-5", "gpt-5.4", "o3-mini", "glm-5.2"]) {
      const levels = getSelectableEfforts(capFor(model, "openai", "https://gateway.example.com/v1"));
      const idx = levels.map(l => order.indexOf(l));
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
    }
  });
});

describe("cycleEffortForModel：在模型可选档位内循环", () => {
  test("每按一次都产生可见变化（不会卡在同一档）", () => {
    // 这是本次问题的核心回归点：此前按全量 5 档循环 + 事后钳制，
    // o-series 上 xhigh/max 都塌成 high，用户连按方向键看起来「没反应」。
    for (const [model, provider, baseURL] of [
      ["o3-mini", "openai", "https://api.openai.com/v1"],
      ["glm-5.2", "openai", "https://gateway.example.com/v1"],
      ["ali-deepseek-v4-pro", "openai", "https://gateway.example.com/v1"],
      ["claude-opus-5", "anthropic", "https://code.ppchat.vip"],
    ] as const) {
      const cap = capFor(model, provider, baseURL);
      const levels = getSelectableEfforts(cap);
      let cur: EffortLevel | undefined = cap.defaultEffort;
      for (let i = 0; i < levels.length * 2; i++) {
        const next = cycleEffortForModel(cap, cur, 1);
        expect(next).toBeDefined();
        expect(levels).toContain(next!);
        if (levels.length > 1) expect(next).not.toBe(cur);
        cur = next;
      }
    }
  });

  test("循环覆盖全部可选档位后环回起点", () => {
    const cap = capFor("o3-mini", "openai", "https://api.openai.com/v1");
    const levels = getSelectableEfforts(cap); // [low, medium, high]
    const walk: EffortLevel[] = [];
    let cur: EffortLevel | undefined = "low";
    for (let i = 0; i < levels.length; i++) {
      cur = cycleEffortForModel(cap, cur, 1);
      walk.push(cur!);
    }
    expect(walk).toEqual(["medium", "high", "low"]);
  });

  test("左移是右移的逆操作", () => {
    const cap = capFor("glm-5.2", "openai", "https://gateway.example.com/v1");
    for (const lv of getSelectableEfforts(cap)) {
      const right = cycleEffortForModel(cap, lv, 1);
      expect(cycleEffortForModel(cap, right, -1)).toBe(lv);
    }
  });

  test("永不返回模型不支持的档位", () => {
    const cap = capFor("ali-deepseek-v4-pro", "openai", "https://gateway.example.com/v1");
    // 从一个「不在可选集内」的档位起步（如刚从别的模型切过来，runtime 还是 low）
    let cur: EffortLevel | undefined = "low";
    for (let i = 0; i < 6; i++) {
      cur = cycleEffortForModel(cap, cur, 1);
      expect(["high", "max"]).toContain(cur!);
    }
  });

  test("当前档位不在可选集内时仍有响应（不返回 undefined）", () => {
    const cap = capFor("o3-mini", "openai", "https://api.openai.com/v1");
    expect(cycleEffortForModel(cap, "max", 1)).toBeDefined();
    expect(cycleEffortForModel(cap, "xhigh", -1)).toBeDefined();
  });

  test("current 为 undefined（auto 态未解析）时以默认档起步", () => {
    const cap = capFor("o3-mini", "openai", "https://api.openai.com/v1");
    // 默认 medium → 右移应到 high
    expect(cycleEffortForModel(cap, undefined, 1)).toBe("high");
  });

  test("不支持 effort 的模型返回 undefined（调用方忽略按键）", () => {
    const noop: EffortCapability = {
      ...CAP,
      supportsEffort: false,
      applyToSendParams: () => {},
    } as unknown as EffortCapability;
    expect(cycleEffortForModel(noop, "high", 1)).toBeUndefined();
  });

  test("仅一档可选时原地返回该档，不抛异常", () => {
    const single: EffortCapability = {
      supportsEffort: true,
      supportsMaxEffort: false,
      supportsThinkingToggle: false,
      thinkingDefaultOn: true,
      defaultEffort: "high",
      // 恒定映射到 high → 只有 high 自映射成立
      applyToSendParams: (p: any) => { p.reasoningEffort = "high"; },
    } as unknown as EffortCapability;
    expect(getSelectableEfforts(single)).toEqual(["high"]);
    expect(cycleEffortForModel(single, "high", 1)).toBe("high");
    expect(cycleEffortForModel(single, "high", -1)).toBe("high");
  });
});

describe("resolveDisplayedEffort", () => {
  test("无状态返回 undefined", () => {
    expect(resolveDisplayedEffort(undefined)).toBeUndefined();
  });

  test("非 auto 态优先取 runtime", () => {
    expect(
      resolveDisplayedEffort({ runtime: "low", applied: "high", isAuto: false, capability: CAP }),
    ).toBe("low");
  });

  test("auto 态取 applied 实际档位", () => {
    expect(
      resolveDisplayedEffort({ runtime: undefined, applied: "high", isAuto: true, capability: CAP }),
    ).toBe("high");
  });

  test("非 auto 但 runtime 为空时回退 applied", () => {
    expect(
      resolveDisplayedEffort({ runtime: undefined, applied: "medium", isAuto: false, capability: CAP }),
    ).toBe("medium");
  });
});
