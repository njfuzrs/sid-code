/**
 * pickSlowHint 纯函数单测 — §6.3
 *
 * 慢提示阈值逻辑：根据静默秒数（距上次收到模型输出的秒数）返回对应提示。
 *
 * 阈值设计依据（见 loading-phrases.ts 注释）：
 * - 15s：首档，给「没卡死、还在跑」的定心丸，纯陈述事实不催促
 * - 60s：真静默一分钟仍零输出，给 esc 出口
 * - 宁晚报也不早报——大模型本来就可能慢，过早提示误导用户
 */

import { test, expect, describe } from "bun:test";
import { pickSlowHint } from "../../../src/ui/constants/loading-phrases.ts";

describe("pickSlowHint — 慢提示阈值", () => {
  test("未达首档阈值 (silenceSec < 15) → null", () => {
    expect(pickSlowHint(0)).toBeNull();
    expect(pickSlowHint(5)).toBeNull();
    expect(pickSlowHint(14)).toBeNull();
  });

  test("达到首档阈值 (silenceSec >= 15, < 60) → 温和告知名不催促", () => {
    expect(pickSlowHint(15)).toBe("仍在等待响应…");
    expect(pickSlowHint(20)).toBe("仍在等待响应…");
    expect(pickSlowHint(35)).toBe("仍在等待响应…");
    expect(pickSlowHint(59)).toBe("仍在等待响应…");
  });

  test("达到次档阈值 (silenceSec >= 60) → 给出 esc 出口", () => {
    expect(pickSlowHint(60)).toBe("等待较久，可按 esc 取消");
    expect(pickSlowHint(65)).toBe("等待较久，可按 esc 取消");
    expect(pickSlowHint(120)).toBe("等待较久，可按 esc 取消");
    expect(pickSlowHint(999)).toBe("等待较久，可按 esc 取消");
  });

  test("阈值边界：15 秒整点命中首档", () => {
    expect(pickSlowHint(15)).not.toBeNull();
    expect(pickSlowHint(14)).toBeNull();
  });

  test("阈值边界：60 秒整点命中次档", () => {
    expect(pickSlowHint(60)).toBe("等待较久，可按 esc 取消");
    expect(pickSlowHint(59)).not.toBe("等待较久，可按 esc 取消");
  });

  test("负数静默时长（不应出现，防御性）→ null", () => {
    expect(pickSlowHint(-1)).toBeNull();
    expect(pickSlowHint(-10)).toBeNull();
  });
});
