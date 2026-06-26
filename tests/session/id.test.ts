/**
 * session/id.ts 单元测试 —— 会话 ID 新格式（YYYYMMDD-HHMMSS-<hex>）。
 */

import { describe, test, expect } from "bun:test";
import { generateSessionId } from "../../src/session/id.ts";

describe("generateSessionId", () => {
  test("格式为 YYYYMMDD-HHMMSS-<8位hex>", () => {
    const id = generateSessionId();
    expect(id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{8}$/);
    expect(id.length).toBe(24);
  });

  test("时间前缀反映传入时刻（可排序基础）", () => {
    // 固定时刻：2026-06-27 14:30:52（本地时区）
    const d = new Date(2026, 5, 27, 14, 30, 52);
    const id = generateSessionId(d);
    expect(id.startsWith("20260627-143052-")).toBe(true);
  });

  test("字典序 = 时间序（更晚的会话排在更后）", () => {
    const early = generateSessionId(new Date(2026, 0, 1, 0, 0, 0));
    const late = generateSessionId(new Date(2026, 11, 31, 23, 59, 59));
    expect(early < late).toBe(true);
  });

  test("同一时刻多次生成随机后缀不同（抗碰撞）", () => {
    const d = new Date(2026, 5, 27, 14, 30, 52);
    const ids = new Set(Array.from({ length: 200 }, () => generateSessionId(d)));
    // 200 次同秒生成，8 位 hex 后缀几乎不可能碰撞
    expect(ids.size).toBe(200);
  });

  test("月/日/时/分/秒个位数补零", () => {
    const d = new Date(2026, 0, 5, 3, 7, 9); // 1月5日 03:07:09
    const id = generateSessionId(d);
    expect(id.startsWith("20260105-030709-")).toBe(true);
  });
});
