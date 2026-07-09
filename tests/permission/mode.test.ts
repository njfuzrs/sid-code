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

describe("键盘循环跳过 plan + auto 的逻辑", () => {
  /**
   * 复刻 app.ts cyclePermissionMode 的跳过逻辑：取 getNextPermissionMode 结果，
   * 若为 plan 或 auto 则继续跳（最多 2 次，覆盖 acceptEdits→plan→auto 连续两档）。
   * - plan：独立状态机，键盘只改字符串会造假 plan 态；
   * - auto：classifier 从未注入（死档），行为等价 default，放进循环只会困惑用户。
   */
  function cycleSkip(mode: PermissionMode, isBypassAvailable: boolean): PermissionMode {
    const ctx: PermissionModeContext = { mode, isBypassAvailable };
    let next = getNextPermissionMode(ctx);
    for (let i = 0; i < 2 && (next === "plan" || next === "auto"); i++) {
      next = getNextPermissionMode({ ...ctx, mode: next });
    }
    return next;
  }

  it("完整循环序列（bypass 不可用）: default↔acceptEdits", () => {
    const seq: string[] = [];
    let mode: PermissionMode = "default";
    for (let i = 0; i < 10; i++) {
      mode = cycleSkip(mode, false);
      seq.push(mode);
      if (mode === "default") break;
    }
    expect(seq).toEqual(["acceptEdits", "default"]);
  });

  it("完整循环序列（bypass 可用）: default→acceptEdits→always-allow→default", () => {
    const seq: string[] = [];
    let mode: PermissionMode = "default";
    for (let i = 0; i < 10; i++) {
      mode = cycleSkip(mode, true);
      seq.push(mode);
      if (mode === "default") break;
    }
    expect(seq).toEqual(["acceptEdits", "always-allow", "default"]);
  });

  it("从 deny-write 循环直接回 default", () => {
    expect(cycleSkip("deny-write", false)).toBe("default");
  });

  it("plan 与 auto 都不出现在序列中", () => {
    const modes: PermissionMode[] = ["default", "acceptEdits", "auto", "always-allow", "deny-write", "dontAsk"];
    for (const m of modes) {
      const next = cycleSkip(m, true);
      expect(next).not.toBe("plan");
      expect(next).not.toBe("auto");
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
