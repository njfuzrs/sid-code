/**
 * 权限模式循环切换单测
 * 验证 getNextPermissionMode 的序列正确性 + 键盘循环跳过 plan 的逻辑。
 */

import { describe, it, expect } from "bun:test";
import { getNextPermissionMode, getModeName } from "../../src/permission/mode.ts";
import type { PermissionMode, PermissionModeContext } from "../../src/permission/mode.ts";

describe("getNextPermissionMode", () => {
  it("default → acceptEdits（基本循环首步）", () => {
    expect(getNextPermissionMode({ mode: "default", isBypassAvailable: false })).toBe("acceptEdits");
  });

  it("acceptEdits → plan（原始循环含 plan）", () => {
    expect(getNextPermissionMode({ mode: "acceptEdits", isBypassAvailable: false })).toBe("plan");
  });

  it("plan → auto", () => {
    expect(getNextPermissionMode({ mode: "plan", isBypassAvailable: false })).toBe("auto");
  });

  it("auto → default（bypass 不可用时跳过 always-allow）", () => {
    expect(getNextPermissionMode({ mode: "auto", isBypassAvailable: false })).toBe("default");
  });

  it("auto → always-allow（bypass 可用时）", () => {
    expect(getNextPermissionMode({ mode: "auto", isBypassAvailable: true })).toBe("always-allow");
  });

  it("always-allow → default", () => {
    expect(getNextPermissionMode({ mode: "always-allow", isBypassAvailable: true })).toBe("default");
  });

  it("deny-write → default（特殊态逃生口）", () => {
    expect(getNextPermissionMode({ mode: "deny-write", isBypassAvailable: false })).toBe("default");
  });

  it("dontAsk → default（特殊态逃生口）", () => {
    expect(getNextPermissionMode({ mode: "dontAsk", isBypassAvailable: false })).toBe("default");
  });

  it("dangerously-skip-permissions → default（未知态走 default 分支）", () => {
    expect(getNextPermissionMode({ mode: "dangerously-skip-permissions", isBypassAvailable: false })).toBe("default");
  });
});

describe("键盘循环跳过 plan 的逻辑", () => {
  /**
   * 模拟 app.ts cyclePermissionMode 的跳过逻辑：
   * 取 getNextPermissionMode 结果，若为 plan 则再跳一档。
   */
  function cycleSkipPlan(mode: PermissionMode, isBypassAvailable: boolean): PermissionMode {
    const ctx: PermissionModeContext = { mode, isBypassAvailable };
    let next = getNextPermissionMode(ctx);
    if (next === "plan") {
      next = getNextPermissionMode({ ...ctx, mode: "plan" });
    }
    return next;
  }

  it("完整循环序列（bypass 不可用）: default→acceptEdits→auto→default", () => {
    const seq: string[] = [];
    let mode: PermissionMode = "default";
    for (let i = 0; i < 10; i++) {
      mode = cycleSkipPlan(mode, false);
      seq.push(mode);
      if (mode === "default") break;
    }
    expect(seq).toEqual(["acceptEdits", "auto", "default"]);
  });

  it("完整循环序列（bypass 可用）: default→acceptEdits→auto→always-allow→default", () => {
    const seq: string[] = [];
    let mode: PermissionMode = "default";
    for (let i = 0; i < 10; i++) {
      mode = cycleSkipPlan(mode, true);
      seq.push(mode);
      if (mode === "default") break;
    }
    expect(seq).toEqual(["acceptEdits", "auto", "always-allow", "default"]);
  });

  it("从 deny-write 循环直接回 default", () => {
    expect(cycleSkipPlan("deny-write", false)).toBe("default");
  });

  it("plan 不出现在序列中", () => {
    const modes: PermissionMode[] = ["default", "acceptEdits", "auto", "always-allow", "deny-write", "dontAsk"];
    for (const m of modes) {
      const next = cycleSkipPlan(m, true);
      expect(next).not.toBe("plan");
    }
  });
});

describe("getModeName", () => {
  it("各模式均有中文名称", () => {
    expect(getModeName("default")).toBe("默认");
    expect(getModeName("always-allow")).toBe("全部允许");
    expect(getModeName("auto")).toBe("自动模式");
    expect(getModeName("acceptEdits")).toBe("自动接受编辑");
    expect(getModeName("plan")).toBe("计划模式");
  });
});
