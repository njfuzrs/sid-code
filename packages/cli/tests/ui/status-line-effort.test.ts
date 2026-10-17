/**
 * 状态栏 effort/thinking 派生单测（useStatusLineData 的纯函数部分）。
 * 纯函数不依赖 React，可直接单测。
 */

import { describe, expect, test } from "bun:test";
import { deriveEffort, deriveThinking } from "@sid-code/cli/ui/hooks/useStatusLineData.ts";
import {
  EFFORT_LOW,
  EFFORT_MEDIUM,
  EFFORT_HIGH,
  EFFORT_MAX,
  EFFORT_AUTO,
} from "@sid-code/cli/ui/constants/figures.ts";

const GRAY = "#888";

describe("deriveEffort", () => {
  test("null → 不渲染该列", () => {
    expect(deriveEffort(null, GRAY)).toBeNull();
  });

  test("显式档位 → 对应填充字形 + 档位名", () => {
    expect(deriveEffort({ level: "low", isAuto: false }, GRAY)).toMatchObject({
      glyph: EFFORT_LOW,
      text: "low",
    });
    expect(deriveEffort({ level: "medium", isAuto: false }, GRAY)?.glyph).toBe(EFFORT_MEDIUM);
    expect(deriveEffort({ level: "high", isAuto: false }, GRAY)?.glyph).toBe(EFFORT_HIGH);
    expect(deriveEffort({ level: "max", isAuto: false }, GRAY)?.glyph).toBe(EFFORT_MAX);
  });

  test("max 档用品牌色点睛，其余用默认灰", () => {
    const max = deriveEffort({ level: "max", isAuto: false }, GRAY);
    const high = deriveEffort({ level: "high", isAuto: false }, GRAY);
    expect(max?.color).not.toBe(GRAY); // max 点睛色
    expect(high?.color).toBe(GRAY);
  });

  test("auto 态 → 空心点字形前缀 + 档位名（去掉 (auto) 文字后缀）+ 灰色", () => {
    const r = deriveEffort({ level: "high", isAuto: true }, GRAY);
    expect(r?.glyph).toBe(EFFORT_AUTO);
    expect(r?.text).toBe(`${EFFORT_AUTO} high`);
    expect(r?.text).not.toContain("(auto)");
    expect(r?.color).toBe(GRAY);
  });
});

describe("deriveThinking", () => {
  test("null → 不渲染该列", () => {
    expect(deriveThinking(null, GRAY)).toBeNull();
  });

  test("只渲染词，不再用 ✻ / ✧ 字形（字形相近，用户把 auto 开读成关）", () => {
    for (const d of [
      { on: true, isAuto: false },
      { on: false, isAuto: false },
      { on: true, isAuto: true },
      { on: false, isAuto: true },
    ]) {
      const r = deriveThinking(d, GRAY);
      expect(r?.glyph).not.toMatch(/[✻✧]/);
      expect(r?.glyph).toBe(r?.text);
    }
  });

  test("手动 on / off", () => {
    expect(deriveThinking({ on: true, isAuto: false }, GRAY)?.text).toBe("on");
    expect(deriveThinking({ on: false, isAuto: false }, GRAY)?.text).toBe("off");
  });

  test("auto 态带 auto· 前缀，写明解析结果", () => {
    expect(deriveThinking({ on: true, isAuto: true }, GRAY)?.text).toBe("auto·on");
    expect(deriveThinking({ on: false, isAuto: true }, GRAY)?.text).toBe("auto·off");
  });

  test("颜色只看实际是否思考：auto·on 与 on 同为亮色，auto·off 与 off 同为灰", () => {
    const on = deriveThinking({ on: true, isAuto: false }, GRAY)?.color;
    expect(on).not.toBe(GRAY);
    // 回归：此前 auto·on 是灰色，与「关」同色，正是误读的直接成因（会话 20261018-001308-45d2c40b）
    expect(deriveThinking({ on: true, isAuto: true }, GRAY)?.color).toBe(on);
    expect(deriveThinking({ on: false, isAuto: true }, GRAY)?.color).toBe(GRAY);
    expect(deriveThinking({ on: false, isAuto: false }, GRAY)?.color).toBe(GRAY);
  });

  test("locked-on → always；意图 off 时转警告色（与正常态颜色不同）", () => {
    const normal = deriveThinking({ on: true, isAuto: true, control: "locked-on" }, GRAY);
    expect(normal?.text).toBe("always");
    const offIntent = deriveThinking(
      { on: true, isAuto: false, control: "locked-on", intent: "off" },
      GRAY,
    );
    expect(offIntent?.text).toBe("always");
    expect(offIntent?.color).not.toBe(normal?.color);
    expect(offIntent?.color).not.toBe(GRAY);
  });

  test("none（无独立开关）→ by-model，仍渲染（D6：没显示被读成已关）", () => {
    const r = deriveThinking({ on: false, isAuto: true, control: "none" }, GRAY);
    expect(r?.text).toBe("by-model");
    expect(r?.color).toBe(GRAY);
  });

  test("Footer 文本全部是英文词（与其它列一致，不混中文）", () => {
    const states = [
      { on: true, isAuto: false },
      { on: true, isAuto: true },
      { on: false, isAuto: true },
      { on: true, isAuto: false, control: "locked-on" as const, intent: "off" as const },
      { on: false, isAuto: true, control: "none" as const },
    ];
    for (const st of states) {
      expect(deriveThinking(st, GRAY)?.text).toMatch(/^[a-z·-]+$/);
    }
  });
});
