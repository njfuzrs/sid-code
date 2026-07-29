/**
 * 权限模式每轮可见单测（query/permission-reminder.ts，缺口 C）
 *
 * 覆盖：mode 指南复用 PERMISSION_MODE_DESCRIPTIONS、切换 vs 持续文案、未知 mode 返回 null。
 */

import { describe, test, expect } from "bun:test";
import {
  buildPermissionModeReminder,
  isRuntimeModeSwitch,
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

// ─── 负收益防线审计 发现 4（2026-07-30）：首轮"切换通告"是零新信息 ───

describe("isRuntimeModeSwitch — 区分基线初始化与真实切换", () => {
  test("lastSeen 为 undefined（会话首轮基线）不算切换", () => {
    // 这是发现 4 的核心：旧判据 `lastSeen !== mode` 在首轮必然为 true，
    // 导致每个以非 default mode 启动的会话首轮都注入"权限模式已切换为…"。
    expect(isRuntimeModeSwitch(undefined, "acceptEdits")).toBe(false);
  });

  test("已有值且不同 → 真实切换", () => {
    expect(isRuntimeModeSwitch("default", "acceptEdits")).toBe(true);
    expect(isRuntimeModeSwitch("acceptEdits", "deny-write")).toBe(true);
  });

  test("已有值且相同 → 非切换", () => {
    expect(isRuntimeModeSwitch("acceptEdits", "acceptEdits")).toBe(false);
  });
});

describe("发现 4：模拟主循环跨轮门控（首轮静默、真实切换才通告）", () => {
  /** 复刻 loop.ts 的 mode 提醒门控，逐轮返回注入的文案（null=未注入） */
  function simulate(modesByTurn: string[], startTurn = 1): Array<string | null> {
    const state: {
      lastSeenPermissionMode?: string;
      lastPermissionModeReminderTurn?: number;
      lastInjectedPermissionModeText?: string;
    } = {};
    const out: Array<string | null> = [];
    modesByTurn.forEach((mode, i) => {
      const turnCount = startTurn + i;
      let injected: string | null = null;
      if (mode && mode !== "default" && mode !== "plan") {
        const isBaseline = state.lastSeenPermissionMode === undefined;
        const changed = isRuntimeModeSwitch(state.lastSeenPermissionMode, mode);
        if (isBaseline) state.lastPermissionModeReminderTurn = turnCount;
        const turnsSince = turnCount - (state.lastPermissionModeReminderTurn ?? 0);
        if (!isBaseline && (changed || turnsSince >= PERMISSION_MODE_REMINDER_INTERVAL)) {
          const reminder = buildPermissionModeReminder(mode, changed);
          const isDuplicate = !changed && reminder !== null
            && reminder === state.lastInjectedPermissionModeText;
          if (reminder && !isDuplicate) {
            injected = reminder;
            state.lastPermissionModeReminderTurn = turnCount;
            state.lastInjectedPermissionModeText = reminder;
          } else if (isDuplicate) {
            state.lastPermissionModeReminderTurn = turnCount;
          }
        }
      }
      state.lastSeenPermissionMode = mode;
      out.push(injected);
    });
    return out;
  }

  test("会话全程同一 mode：首轮不再注入'已切换'（实测 37 次零新信息的来源）", () => {
    const injections = simulate(Array(6).fill("acceptEdits"));
    expect(injections[0]).toBeNull();
    // 前 6 轮（< 间隔 8）一次都不注入：mode 从未变过，system prompt 已含指南
    expect(injections.every((x) => x === null)).toBe(true);
  });

  test("运行时真实切换那一轮仍强注入'已切换'（缺口 C 本意不被改坏）", () => {
    const injections = simulate(["acceptEdits", "acceptEdits", "deny-write"]);
    expect(injections[0]).toBeNull();
    expect(injections[1]).toBeNull();
    expect(injections[2]).not.toBeNull();
    expect(injections[2]).toContain("已切换");
    expect(injections[2]).toContain("deny-write");
  });

  test("长会话仍有低频重述（防遗忘），但只发生在基线之后", () => {
    const injections = simulate(Array(PERMISSION_MODE_REMINDER_INTERVAL + 2).fill("acceptEdits"));
    expect(injections[0]).toBeNull();
    const injectedTurns = injections.flatMap((x, i) => (x ? [i] : []));
    // 重述至少发生一次，且不在首轮
    expect(injectedTurns.length).toBeGreaterThanOrEqual(1);
    expect(injectedTurns).not.toContain(0);
    expect(injections[injectedTurns[0]]).toContain("持续遵守");
  });

  test("恢复会话（turnCount 已远超间隔）首轮也不注入——cadence 锚在基线", () => {
    // 若不在基线处锚定 cadence，turnsSince = 50 - 0 ≥ 8 会立刻触发一次"到期"重述，
    // 又回到首轮零新信息注入。
    const injections = simulate(["acceptEdits", "acceptEdits"], 50);
    expect(injections[0]).toBeNull();
    expect(injections[1]).toBeNull();
  });

  test("切回 default 再切走能重新识别为切换", () => {
    const injections = simulate(["acceptEdits", "default", "acceptEdits"]);
    expect(injections[0]).toBeNull();   // 基线
    expect(injections[1]).toBeNull();   // default 不注入
    expect(injections[2]).toContain("已切换"); // 从 default 切走 → 真实切换
  });
});
