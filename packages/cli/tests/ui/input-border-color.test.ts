/**
 * 输入框边框配色回归测试。
 *
 * 背景：117eb940 把输入框改成只画上下横线后，边框色一步跨到 `theme.text.primary`
 * （暗色下对比度 11.34），比它框住的输入正文和点睛的 `>` 提示符都更亮，加上横线
 * 通宽跑满终端、面积被放大，观感上"输入框很显眼、颜色不协调"。
 *
 * 本次修法：边框取 `>` 的同一色相（品牌蓝 `ui.active`）混向背景，压到目标对比度
 * ~2.6 —— 同族递进（`src/ui/CLAUDE.md` L1 元原则①），色相统一、明度分层。
 *
 * 这里锁三件事，防以后又调回过亮/过暗：
 * 1. `mixToContrast` 按目标对比度反解比例（不是写死混合百分比），全主题收敛一致；
 * 2. 边框明确弱于 `>` 与输入正文（视觉层次不能再反）；
 * 3. 边框与 `>` 色相同族（"统一"的落点是色相，不是色值）。
 */

import { describe, expect, test } from "bun:test";
import tinycolor from "tinycolor2";
import { mixToContrast } from "@sid-code/cli/ui/themes/color-utils.ts";
import {
  darkSemanticColors,
  lightSemanticColors,
  githubDarkSemanticColors,
  githubLightSemanticColors,
  daltonizedDarkSemanticColors,
  daltonizedLightSemanticColors,
  type SemanticColors,
} from "@sid-code/cli/ui/themes/semantic-tokens.ts";

/** 与 `InputArea.tsx` 的 `BORDER_TARGET_CONTRAST` 保持一致。 */
const TARGET = 2.6;

const THEMES: [string, SemanticColors][] = [
  ["dark", darkSemanticColors],
  ["light", lightSemanticColors],
  ["github-dark", githubDarkSemanticColors],
  ["github-light", githubLightSemanticColors],
  ["daltonized-dark", daltonizedDarkSemanticColors],
  ["daltonized-light", daltonizedLightSemanticColors],
];

/** 复刻 `InputArea.tsx` 的 `inputBorderColor()` 取色。 */
const borderColorOf = (c: SemanticColors) =>
  mixToContrast(c.ui.active, c.background.primary, TARGET);

describe("mixToContrast — 按目标对比度反解混合比例", () => {
  test("结果对比度不超过目标，且不过度衰减到糊进背景", () => {
    for (const [name, c] of THEMES) {
      const bg = c.background.primary;
      const border = borderColorOf(c);
      const ratio = tinycolor.readability(border, bg);
      // 上界：不得超过目标（超了就开始与正文抢重心）
      expect(ratio, `${name} 边框对比度上界`).toBeLessThanOrEqual(TARGET + 0.05);
      // 下界：低于 2.0 会糊进背景框不住（旧 border.default 暗色仅 1.80 就是这个毛病）
      expect(ratio, `${name} 边框对比度下界`).toBeGreaterThan(2.0);
    }
  });

  test("已经足够弱的颜色原样返回，不会被反向加强", () => {
    const bg = "#1e1e2e";
    const weak = "#45475a"; // border.default，对比度 1.80 < 2.6
    expect(mixToContrast(weak, bg, TARGET)).toBe(weak);
  });

  test("无效颜色输入原样返回，不抛异常", () => {
    expect(mixToContrast("not-a-color", "#1e1e2e", TARGET)).toBe("not-a-color");
    expect(mixToContrast("#89b4fa", "nope", TARGET)).toBe("#89b4fa");
  });

  test("目标对比度越低，结果越靠近背景（单调）", () => {
    const bg = "#1e1e2e";
    const brand = "#89b4fa";
    const loose = tinycolor.readability(mixToContrast(brand, bg, 4.0), bg);
    const tight = tinycolor.readability(mixToContrast(brand, bg, 2.0), bg);
    expect(loose).toBeGreaterThan(tight);
  });
});

describe("输入框边框 — 视觉层次不得反转", () => {
  test("边框弱于 `>` 提示符，也弱于输入正文", () => {
    for (const [name, c] of THEMES) {
      const bg = c.background.primary;
      const border = tinycolor.readability(borderColorOf(c), bg);
      const prompt = tinycolor.readability(c.ui.active, bg);
      const body = tinycolor.readability(c.text.primary, bg);

      expect(border, `${name}: 边框应弱于 > 提示符`).toBeLessThan(prompt);
      expect(border, `${name}: 边框应弱于输入正文`).toBeLessThan(body);
    }
  });

  test("不再等于 text.primary（旧值，正是「很显眼」的根因）", () => {
    for (const [name, c] of THEMES) {
      expect(borderColorOf(c).toLowerCase(), `${name}`).not.toBe(c.text.primary.toLowerCase());
    }
  });
});

describe("输入框边框 — 与 `>` 提示符色相统一", () => {
  test("边框与 ui.active 同色相（容差 8°）", () => {
    for (const [name, c] of THEMES) {
      const bh = tinycolor(borderColorOf(c)).toHsl().h;
      const ph = tinycolor(c.ui.active).toHsl().h;
      // 环形色相差
      const diff = Math.min(Math.abs(bh - ph), 360 - Math.abs(bh - ph));
      expect(diff, `${name} 色相差`).toBeLessThan(8);
    }
  });
});
