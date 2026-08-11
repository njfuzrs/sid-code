/**
 * P1-2：agent 身份色（frontmatter color 注册 + 消费面）单测
 *
 * 覆盖：
 * - setAgentColor 合法/非法色名（非法返回 false，调用方回退哈希分配）
 * - getAgentColor 优先显式声明色，未声明走哈希分配且稳定
 * - toInkColor / getAgentInkColor 产出 ink 可识别的 ansi256(n) 形式（不含裸 ANSI 转义）
 * - colorize 仍产出 ANSI 转义（非 TUI 场景，如 team_create 汇总文本）
 * - 通知链把 agentType 透传进结构化快照（TUI 据此取色），且不进 XML
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  setAgentColor,
  getAgentColor,
  getAgentInkColor,
  toInkColor,
  colorize,
  assignAgentColor,
  isValidAgentColorName,
  clearExplicitAgentColors,
} from "@sid-code/core/agent/color.ts";
import { formatNotification } from "@sid-code/core/task/notification.ts";

beforeEach(() => {
  clearExplicitAgentColors();
});

describe("frontmatter color 注册与取色", () => {
  it("合法色名注册成功，getAgentColor 优先返回声明色", () => {
    expect(setAgentColor("my-agent", "blue")).toBe(true);
    expect(getAgentColor("my-agent").name).toBe("blue");
  });

  it("色名大小写不敏感", () => {
    expect(setAgentColor("my-agent", "GREEN")).toBe(true);
    expect(getAgentColor("my-agent").name).toBe("green");
  });

  it("非法色名返回 false 且不注册（回退哈希分配）", () => {
    expect(setAgentColor("my-agent", "chartreuse")).toBe(false);
    expect(isValidAgentColorName("chartreuse")).toBe(false);
    // 未注册 → 与哈希分配结果一致
    expect(getAgentColor("my-agent")).toEqual(assignAgentColor("my-agent"));
  });

  it("未声明色的 agent 哈希取色稳定（同名多次调用同色）", () => {
    const a = getAgentColor("explore");
    const b = getAgentColor("explore");
    expect(a).toEqual(b);
  });
});

describe("ink 渲染取色入口", () => {
  it("toInkColor 产出 ansi256(n) 而非裸 ANSI 转义", () => {
    const c = getAgentColor("explore");
    const ink = toInkColor(c);
    expect(ink).toBe(`ansi256(${c.code})`);
    // 关键：不能含 ESC——裸转义会被 ink 的宽度计算当可见字符，导致对齐漂移
    expect(ink).not.toContain("\x1b");
  });

  it("getAgentInkColor 尊重显式声明色", () => {
    setAgentColor("api-dev", "purple");
    const expected = toInkColor(getAgentColor("api-dev"));
    expect(getAgentInkColor("api-dev")).toBe(expected);
  });

  it("colorize 仍产出 ANSI 转义（非 TUI 的纯文本汇总场景）", () => {
    const out = colorize("hello", getAgentColor("explore"));
    expect(out).toContain("\x1b[38;5;");
    expect(out).toContain("hello");
  });
});

describe("通知链透传 agentType（TUI 取色数据源）", () => {
  const base = {
    taskId: "t1",
    outputFile: "/tmp/out.txt",
    status: "completed" as const,
    summary: 'Agent "查X" 执行完成',
  };

  it("agentType 不进 <task-notification> XML（模型不需要）", () => {
    const xml = formatNotification({
      ...base,
      agentType: "explore",
      result: {
        output: "结论",
        totalToolUseCount: 1,
        totalTokens: 10,
        usage: { inputTokens: 5, outputTokens: 5 },
      } as any,
    });
    expect(xml).toContain("<status>completed</status>");
    expect(xml).not.toContain("explore");
    expect(xml).not.toContain("agentType");
  });
});
