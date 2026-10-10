import { describe, expect, test } from "bun:test";
import {
  routeCommandResult,
  COMMAND_STATUS_MS,
  COMMAND_ERROR_STATUS_MS,
} from "../../src/ui/command-result-route.ts";

describe("routeCommandResult：命令结果不进消息流", () => {
  test("短回执（/model xxx）→ 状态栏，不是消息流", () => {
    const r = routeCommandResult(
      "主模型已切换为: claude-opus-5-5，并已保存到 settings.json（跨会话生效）",
    );
    expect(r).toEqual({
      to: "status",
      text: "主模型已切换为: claude-opus-5-5，并已保存到 settings.json（跨会话生效）",
      delayMs: COMMAND_STATUS_MS,
    });
  });

  test("两行回执压成一行，带首尾空白也不留空段", () => {
    const r = routeCommandResult("\n  已切换\n  已保存  \n");
    expect(r).toMatchObject({ to: "status", text: "已切换 · 已保存" });
  });

  test("错误 → 状态栏带 ✗ 且停留更久", () => {
    expect(routeCommandResult("未知命令: /xx", { isError: true })).toEqual({
      to: "status",
      text: "✗ 未知命令: /xx",
      delayMs: COMMAND_ERROR_STATUS_MS,
    });
  });

  test("未声明 outputPanel 的多行输出也进面板（消息流不兜底）", () => {
    expect(routeCommandResult("a\nb\nc")).toEqual({ to: "panel", content: "a\nb\nc", panel: {} });
  });

  test("显式 panel 不受行数下限约束", () => {
    expect(routeCommandResult("一行", { panel: { title: "T" } })).toEqual({
      to: "panel",
      content: "一行",
      panel: { title: "T" },
    });
  });

  test("空输出 → 什么都不显示", () => {
    expect(routeCommandResult(null)).toEqual({ to: "none" });
    expect(routeCommandResult("  \n")).toEqual({ to: "none" });
  });
});
