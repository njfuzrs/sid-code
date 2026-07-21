/**
 * P2-1 /model 面板左右键调 effort：循环/解析纯逻辑测试
 */
import { describe, test, expect } from "bun:test";
import { cycleEffort, resolveDisplayedEffort } from "../../src/ui/components/ModelDialog.tsx";
import type { EffortCapability } from "../../src/llm/effort.ts";

const CAP: EffortCapability = {
  supportsEffort: true,
  supportsMaxEffort: true,
} as unknown as EffortCapability;

describe("cycleEffort", () => {
  test("右移增强，到 max 后环绕回 low", () => {
    expect(cycleEffort("low", 1)).toBe("medium");
    expect(cycleEffort("medium", 1)).toBe("high");
    expect(cycleEffort("high", 1)).toBe("xhigh");
    expect(cycleEffort("xhigh", 1)).toBe("max");
    expect(cycleEffort("max", 1)).toBe("low");
  });

  test("左移减弱，到 low 后环绕回 max", () => {
    expect(cycleEffort("max", -1)).toBe("xhigh");
    expect(cycleEffort("high", -1)).toBe("medium");
    expect(cycleEffort("low", -1)).toBe("max");
  });

  test("current 为 undefined 时以 high 为基准", () => {
    expect(cycleEffort(undefined, 1)).toBe("xhigh");
    expect(cycleEffort(undefined, -1)).toBe("medium");
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
