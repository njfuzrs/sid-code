/**
 * P2-1 /model 面板左右键调 effort：档位解析 + 按模型循环的纯逻辑测试
 *
 * 覆盖「档位与模型配对」这条主线：
 *   getSelectableEfforts   —— 每个模型真实可选的档位集合（不再是全量 5 档硬编码）
 *   cycleEffortForModel    —— 在该集合内循环，每按一次必有可见变化
 *   resolveDisplayedEffort —— 面板显示哪一档（auto 态取实际生效档）
 */
import { describe, test, expect } from "bun:test";
import { resolveDisplayedEffort } from "@sid-code/cli/ui/components/ModelDialog.tsx";
import {
  getSelectableEfforts,
  cycleEffortForModel,
  reconcileEffortForModel,
  isEffortGatedByThinking,
  previewWireEffort,
  resolveEffortCapability,
  type EffortCapability,
  type EffortLevel,
} from "@sid-code/core/llm/effort.ts";

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
    const cap = capFor("gpt-5.4", "openai", "https://gw.example.com/v1");
    expect(getSelectableEfforts(cap)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("o-series 无 max 与 xhigh，只剩 3 档", () => {
    const cap = capFor("o3-mini", "openai", "https://api.openai.com/v1");
    expect(getSelectableEfforts(cap)).toEqual(["low", "medium", "high"]);
  });

  test("DeepSeek 线格式仅认 high/max，low/medium 会被钳制故不列出", () => {
    const cap = capFor("ali-deepseek-v4-pro", "openai", "https://gw.example.com/v1");
    expect(getSelectableEfforts(cap)).toEqual(["high", "max"]);
  });

  test("GLM 支持 max 但 xhigh 被钳制，故为 4 档", () => {
    const cap = capFor("glm-5.2", "openai", "https://gw.example.com/v1");
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
      const levels = getSelectableEfforts(capFor(model, "openai", "https://gw.example.com/v1"));
      const idx = levels.map((l) => order.indexOf(l));
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
      ["glm-5.2", "openai", "https://gw.example.com/v1"],
      ["ali-deepseek-v4-pro", "openai", "https://gw.example.com/v1"],
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
    const cap = capFor("glm-5.2", "openai", "https://gw.example.com/v1");
    for (const lv of getSelectableEfforts(cap)) {
      const right = cycleEffortForModel(cap, lv, 1);
      expect(cycleEffortForModel(cap, right, -1)).toBe(lv);
    }
  });

  test("永不返回模型不支持的档位", () => {
    const cap = capFor("ali-deepseek-v4-pro", "openai", "https://gw.example.com/v1");
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
      applyToSendParams: (p: any) => {
        p.reasoningEffort = "high";
      },
    } as unknown as EffortCapability;
    expect(getSelectableEfforts(single)).toEqual(["high"]);
    expect(cycleEffortForModel(single, "high", 1)).toBe("high");
    expect(cycleEffortForModel(single, "high", -1)).toBe("high");
  });
});

describe("isEffortGatedByThinking：思考关掉后档位是否失效", () => {
  test("GLM / DeepSeek 的 effort 挂在 thinking 分支内 → 被门控", () => {
    expect(isEffortGatedByThinking(capFor("glm-5.2", "openai", "https://gw.example.com/v1"))).toBe(
      true,
    );
    expect(
      isEffortGatedByThinking(capFor("ali-deepseek-v4-pro", "openai", "https://gw.example.com/v1")),
    ).toBe(true);
  });

  test("o-series / GPT-5.x 推理内置，不受 thinking 影响 → 不被门控", () => {
    expect(isEffortGatedByThinking(capFor("o3-mini", "openai", "https://api.openai.com/v1"))).toBe(
      false,
    );
    expect(isEffortGatedByThinking(capFor("gpt-5.4", "openai", "https://gw.example.com/v1"))).toBe(
      false,
    );
  });

  test("原生 Claude 走 budget_tokens、无 reasoning_effort 下发 → 不报门控", () => {
    expect(
      isEffortGatedByThinking(capFor("claude-opus-5", "anthropic", "https://code.ppchat.vip")),
    ).toBe(false);
  });

  test("不支持 effort 的模型返回 false（无档位可谈）", () => {
    const noop: EffortCapability = {
      ...CAP,
      supportsEffort: false,
      applyToSendParams: () => {},
    } as unknown as EffortCapability;
    expect(isEffortGatedByThinking(noop)).toBe(false);
  });
});

describe("reconcileEffortForModel：换模型后档位归正", () => {
  const A = capFor("claude-opus-5", "anthropic", "https://code.ppchat.vip");
  const GLM = capFor("glm-5.2", "openai", "https://gw.example.com/v1");
  const O3 = capFor("o3-mini", "openai", "https://api.openai.com/v1");
  const DS = capFor("ali-deepseek-v4-pro", "openai", "https://gw.example.com/v1");

  test("档位已被新模型支持时不动（不擅自改用户显式选过的档）", () => {
    expect(reconcileEffortForModel(A, "high")).toBe("high");
    expect(reconcileEffortForModel(GLM, "medium")).toBe("medium");
  });

  test("auto 保持 auto（语义本就是跟随新模型默认）", () => {
    expect(reconcileEffortForModel(GLM, undefined)).toBeUndefined();
    expect(reconcileEffortForModel(O3, undefined)).toBeUndefined();
  });

  test("claude 的 xhigh 切到 GLM 归正为实际下发的 max", () => {
    // 回归点：不归正会出现「状态栏显示 xhigh、实发 max、面板 hint 无 xhigh」三方矛盾
    expect(reconcileEffortForModel(GLM, "xhigh")).toBe("max");
  });

  test("max 切到无 max 的 o-series 归正为 high", () => {
    expect(reconcileEffortForModel(O3, "max")).toBe("high");
    expect(reconcileEffortForModel(O3, "xhigh")).toBe("high");
  });

  test("low 切到只认 high/max 的 DeepSeek 归正为 high", () => {
    expect(reconcileEffortForModel(DS, "low")).toBe("high");
    expect(reconcileEffortForModel(DS, "medium")).toBe("high");
  });

  test("归正结果恒在新模型可选集内", () => {
    for (const cap of [A, GLM, O3, DS]) {
      const levels = getSelectableEfforts(cap);
      for (const lv of ["low", "medium", "high", "xhigh", "max"] as EffortLevel[]) {
        expect(levels).toContain(reconcileEffortForModel(cap, lv) as EffortLevel);
      }
    }
  });

  test("归正后「显示档位 == 实际下发档位」（核心不变式）", () => {
    for (const cap of [A, GLM, O3, DS]) {
      for (const lv of ["low", "medium", "high", "xhigh", "max"] as EffortLevel[]) {
        const reconciled = reconcileEffortForModel(cap, lv) as EffortLevel;
        expect(previewWireEffort(cap, reconciled)).toBe(reconciled);
      }
    }
  });

  test("归正是幂等的（再归正一次不变）", () => {
    for (const cap of [A, GLM, O3, DS]) {
      for (const lv of ["low", "medium", "high", "xhigh", "max"] as EffortLevel[]) {
        const once = reconcileEffortForModel(cap, lv);
        expect(reconcileEffortForModel(cap, once)).toBe(once);
      }
    }
  });

  test("不支持 effort 的模型保留旧档位（不下发，留着无害）", () => {
    const noop: EffortCapability = {
      ...CAP,
      supportsEffort: false,
      applyToSendParams: () => {},
    } as unknown as EffortCapability;
    expect(reconcileEffortForModel(noop, "xhigh")).toBe("xhigh");
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
      resolveDisplayedEffort({
        runtime: undefined,
        applied: "high",
        isAuto: true,
        capability: CAP,
      }),
    ).toBe("high");
  });

  test("非 auto 但 runtime 为空时回退 applied", () => {
    expect(
      resolveDisplayedEffort({
        runtime: undefined,
        applied: "medium",
        isAuto: false,
        capability: CAP,
      }),
    ).toBe("medium");
  });
});
