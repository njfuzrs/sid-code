/**
 * 权限模式每轮可见单测（query/permission-reminder.ts，缺口 C）
 *
 * 覆盖：mode 指南复用 PERMISSION_MODE_DESCRIPTIONS、切换 vs 持续文案、未知 mode 返回 null。
 */

import { describe, test, expect } from "bun:test";
import {
  buildPermissionModeReminder,
  PERMISSION_MODE_REMINDER_INTERVAL,
} from "../../src/query/permission-reminder.ts";
import { PERMISSION_MODE_DESCRIPTIONS } from "../../src/config/attachments.ts";

describe("buildPermissionModeReminder — 基础行为", () => {
  test("已知 mode 复用 PERMISSION_MODE_DESCRIPTIONS 文案", () => {
    const r = buildPermissionModeReminder("deny-write", false);
    expect(r).not.toBeNull();
    expect(r).toContain(PERMISSION_MODE_DESCRIPTIONS["deny-write"]);
    expect(r).toContain("<system-reminder>");
  });

  test("acceptEdits / always-allow 等已知 mode 均能生成", () => {
    for (const mode of Object.keys(PERMISSION_MODE_DESCRIPTIONS)) {
      const r = buildPermissionModeReminder(mode, false);
      expect(r).not.toBeNull();
    }
  });

  test("未知 mode（无对应描述）返回 null，不喂空洞约束", () => {
    expect(buildPermissionModeReminder("nonexistent-mode", false)).toBeNull();
    expect(buildPermissionModeReminder("", true)).toBeNull();
  });

  test("mode 键与 permission/mode.ts 的 PermissionMode 对齐（防再次漂移）", () => {
    // acceptEdits / always-allow 是真实运行时值，必须能命中描述（此前漂移为 null）
    expect(buildPermissionModeReminder("acceptEdits", false)).not.toBeNull();
    expect(buildPermissionModeReminder("always-allow", false)).not.toBeNull();
    expect(buildPermissionModeReminder("dangerously-skip-permissions", false)).not.toBeNull();
  });
});

describe("buildPermissionModeReminder — 切换 vs 持续文案", () => {
  test("justChanged=true 强调'已切换'", () => {
    const r = buildPermissionModeReminder("acceptEdits", true)!;
    expect(r).toContain("已切换");
    expect(r).toContain("acceptEdits");
  });

  test("justChanged=false 强调'持续遵守'", () => {
    const r = buildPermissionModeReminder("acceptEdits", false)!;
    expect(r).toContain("持续遵守");
    expect(r).not.toContain("已切换");
  });

  test("含'请勿向用户提及/复述'约束", () => {
    const r = buildPermissionModeReminder("deny-write", false)!;
    expect(r).toContain("请勿向用户");
  });
});

describe("PERMISSION_MODE_REMINDER_INTERVAL", () => {
  test("节流间隔为正整数", () => {
    expect(PERMISSION_MODE_REMINDER_INTERVAL).toBeGreaterThan(0);
    expect(Number.isInteger(PERMISSION_MODE_REMINDER_INTERVAL)).toBe(true);
  });
});
