/**
 * 权限模式循环切换单测
 * 验证 getNextPermissionMode 的序列正确性 + 键盘循环含 plan 的逻辑（M6）。
 */

import { describe, it, expect } from "bun:test";
import {
  getNextPermissionMode,
  getNextKeyboardPermissionMode,
  getModeName,
} from "@sid-code/core/permission/mode.ts";
import type { PermissionMode } from "@sid-code/core/permission/mode.ts";

describe("getNextPermissionMode", () => {
  it("default → acceptEdits（基本循环首步）", () => {
    expect(getNextPermissionMode({ mode: "default", isBypassAvailable: false })).toBe(
      "acceptEdits",
    );
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
    expect(getNextPermissionMode({ mode: "always-allow", isBypassAvailable: true })).toBe(
      "default",
    );
  });

  it("deny-write → default（特殊态逃生口）", () => {
    expect(getNextPermissionMode({ mode: "deny-write", isBypassAvailable: false })).toBe("default");
  });

  it("dontAsk → default（特殊态逃生口）", () => {
    expect(getNextPermissionMode({ mode: "dontAsk", isBypassAvailable: false })).toBe("default");
  });

  it("dangerously-skip-permissions → default（未知态走 default 分支）", () => {
    expect(
      getNextPermissionMode({ mode: "dangerously-skip-permissions", isBypassAvailable: false }),
    ).toBe("default");
  });
});

describe("键盘循环含 plan 的逻辑（M6）", () => {
  /**
   * 直接调生产函数 getNextKeyboardPermissionMode，**不再手抄** app.ts 的跳过逻辑。
   *
   * 这里曾经复刻过一份，然后漂移了：那份连 auto 一起跳（注释写「auto classifier
   * 从未注入（死档）」），但 auto 早已接线 ToolClassifier（cli.ts），生产只跳 plan。
   * 于是本文件曾断言「auto 永不出现在序列中」并一直是绿的——一份测试在为一个
   * 不存在的行为背书，website/use/permissions.md 还照着它把循环顺序写错了。
   * 复刻生产逻辑的测试注定漂移，所以现在两边共用同一个函数。
   *
   * M6 之后 plan 也进循环（对齐 claude-code），跳过逻辑只剩「企业策略禁用的档」。
   * 键盘入口真正进入 plan 时要走状态机（app.ts 的 cyclePermissionMode），
   * 那是 App 层的行为，由 packages/cli/tests/app/shift-tab-plan.test.ts 守。
   */
  function cycleSkip(mode: PermissionMode, isBypassAvailable: boolean): PermissionMode {
    return getNextKeyboardPermissionMode({ mode, isBypassAvailable });
  }

  it("完整循环序列（bypass 不可用）: default→acceptEdits→plan→auto→default", () => {
    const seq: string[] = [];
    let mode: PermissionMode = "default";
    for (let i = 0; i < 10; i++) {
      mode = cycleSkip(mode, false);
      seq.push(mode);
      if (mode === "default") break;
    }
    expect(seq).toEqual(["acceptEdits", "plan", "auto", "default"]);
  });

  it("完整循环序列（bypass 可用）: default→acceptEdits→plan→auto→always-allow→default", () => {
    const seq: string[] = [];
    let mode: PermissionMode = "default";
    for (let i = 0; i < 10; i++) {
      mode = cycleSkip(mode, true);
      seq.push(mode);
      if (mode === "default") break;
    }
    expect(seq).toEqual(["acceptEdits", "plan", "auto", "always-allow", "default"]);
  });

  it("从 deny-write 循环直接回 default", () => {
    expect(cycleSkip("deny-write", false)).toBe("default");
  });

  it("plan 在序列中：acceptEdits 的下一档就是它（M6 之前被跳过）", () => {
    // 反向钉住：这条断言会在「有人又把 plan 塞回跳过列表」时立刻红。
    expect(cycleSkip("acceptEdits", true)).toBe("plan");
    expect(cycleSkip("plan", false)).toBe("auto");
  });

  it("企业策略禁用 plan 时跳过它（不跳 auto）", () => {
    // plan 被禁 → acceptEdits 越过 plan 落到 auto（bypass 不可用）
    expect(
      getNextKeyboardPermissionMode(
        { mode: "acceptEdits", isBypassAvailable: false },
        (m: PermissionMode) => m === "plan",
      ),
    ).toBe("auto");
    // 禁用 auto 不影响 plan：跳过逻辑只跳被禁的那一档
    expect(
      getNextKeyboardPermissionMode(
        { mode: "acceptEdits", isBypassAvailable: false },
        (m: PermissionMode) => m === "auto",
      ),
    ).toBe("plan");
  });
});

describe("getModeName", () => {
  it("各模式均有中文名称", () => {
    expect(getModeName("default")).toBe("Manual（手动）");
    expect(getModeName("always-allow")).toBe("全部允许");
    expect(getModeName("auto")).toBe("自动模式");
    expect(getModeName("acceptEdits")).toBe("自动接受编辑");
    expect(getModeName("plan")).toBe("计划模式");
  });
});
