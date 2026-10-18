/**
 * P2-1 /model 面板左右键调 effort：档位解析 + 按模型循环的纯逻辑测试
 *
 * 覆盖「档位与模型配对」这条主线：
 *   getSelectableEfforts   —— 每个模型真实可选的档位集合（不再是全量 5 档硬编码）
 *   cycleEffortForModel    —— 在该集合内循环，每按一次必有可见变化
 *   getDisplayedEffort     —— 展示档 = 线上实发档（替代已删除的 reconcileEffortForModel）
 *   resolveDisplayedEffort —— 面板显示哪一档（取实发档，与 Footer 同源）
 */
import { describe, test, expect } from "bun:test";
import { resolveDisplayedEffort } from "@sid-code/cli/ui/components/ModelDialog.tsx";
import {
  getSelectableEfforts,
  cycleEffortForModel,
  getDisplayedEffort,
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
  test("原生 Claude（adaptive，注册表声明认 xhigh）5 档全部可选", () => {
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

  test("DeepSeek 线格式认 low/high/max，medium/xhigh 会被钳制故不列出（E5）", () => {
    const cap = capFor("ali-deepseek-v4-pro", "openai", "https://gw.example.com/v1");
    expect(getSelectableEfforts(cap)).toEqual(["low", "high", "max"]);
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
    // 从一个「不在可选集内」的档位起步（如刚从别的模型切过来，runtime 还是 xhigh）
    let cur: EffortLevel | undefined = "xhigh";
    for (let i = 0; i < 6; i++) {
      cur = cycleEffortForModel(cap, cur, 1);
      expect(["low", "high", "max"]).toContain(cur!);
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

  test("可关思考的原生 Claude：关思考后档位不下发 → 报门控（20261018 effort 排查 E4）", () => {
    // 此前探针喂空名 + 只读档位字段，Claude 恒判 false，`/think off` 后面板在空转却不提示。
    expect(
      isEffortGatedByThinking(capFor("claude-opus-5", "anthropic", "https://code.ppchat.vip")),
    ).toBe(true);
  });

  test("恒思考 Claude（Opus 5.5）关不掉 → 不报门控", () => {
    expect(
      isEffortGatedByThinking(capFor("claude-opus-5-5", "anthropic", "https://code.ppchat.vip")),
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

describe("getDisplayedEffort：展示 = 实发，所选档不被改写（PR-C，替代 reconcileEffortForModel）", () => {
  const A = capFor("claude-opus-5", "anthropic", "https://code.ppchat.vip");
  const GLM = capFor("glm-5.2", "openai", "https://gw.example.com/v1");
  const O3 = capFor("o3-mini", "openai", "https://api.openai.com/v1");
  const DS = capFor("ali-deepseek-v4-pro", "openai", "https://gw.example.com/v1");
  const ALL = ["low", "medium", "high", "xhigh", "max"] as EffortLevel[];

  test("档位被新模型支持时原样显示", () => {
    expect(getDisplayedEffort(A, "xhigh", null)).toBe("xhigh");
    expect(getDisplayedEffort(GLM, "medium", null)).toBe("medium");
  });

  test("被钳制的档显示实发档（E2 / E7）", () => {
    expect(getDisplayedEffort(GLM, "xhigh", null)).toBe("max");
    expect(getDisplayedEffort(O3, "max", null)).toBe("high");
    expect(getDisplayedEffort(O3, "xhigh", null)).toBe("high");
    expect(getDisplayedEffort(DS, "xhigh", null)).toBe("high");
    expect(getDisplayedEffort(DS, "medium", null)).toBe("high");
  });

  test("env 覆盖同样映射成实发档（E7：env 改不了 runtime，只能在展示层修）", () => {
    expect(getDisplayedEffort(DS, undefined, "medium")).toBe("high");
    expect(getDisplayedEffort(DS, "max", "xhigh")).toBe("high");
  });

  test("auto 显示模型默认档", () => {
    expect(getDisplayedEffort(DS, undefined, null)).toBe(DS.defaultEffort);
  });

  test("核心不变式：显示档 == 实发档，且恒在可选集内", () => {
    for (const cap of [A, GLM, O3, DS]) {
      const levels = getSelectableEfforts(cap);
      for (const lv of ALL) {
        const shown = getDisplayedEffort(cap, lv, null);
        expect(previewWireEffort(cap, shown)).toBe(shown);
        expect(levels).toContain(shown);
      }
    }
  });

  test("跨模型往返不丢意图：GLM 上显示 max，同一 runtime 回到 Claude 仍是 xhigh", () => {
    // 旧 reconcile 在切到 GLM 时把 runtime 改写成 max，切回 Claude 就只剩 max。
    const runtime: EffortLevel = "xhigh";
    expect(getDisplayedEffort(GLM, runtime, null)).toBe("max");
    expect(getDisplayedEffort(A, runtime, null)).toBe("xhigh");
  });
});

describe("resolveDisplayedEffort", () => {
  test("无状态返回 undefined", () => {
    expect(resolveDisplayedEffort(undefined)).toBeUndefined();
  });

  test("非 auto 态也取 applied（实发档），不取被钳制的 runtime", () => {
    // DeepSeek 上选 medium 实发 high：面板此前显示 low，与 Footer / 线上都不一致。
    expect(
      resolveDisplayedEffort({
        runtime: "medium",
        applied: "high",
        isAuto: false,
        capability: CAP,
      }),
    ).toBe("high");
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
