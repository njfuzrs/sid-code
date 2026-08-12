// 语义颜色接口定义
// 参考 gemini-cli/packages/cli/src/ui/themes/semantic-tokens.ts

import type { Color } from "@sid-code/tui-renderer/styles.ts";

/**
 * 语义色 token 的值类型 = ink 的 `Color`（`#hex` / `rgb()` / `ansi256()` / `ansi:*`），
 * 不是宽松的 `string`。
 *
 * 为什么必须收紧：这些值最终喂给 `<Text color=…>` / `<Box borderColor=…>`，而 ink 的
 * `Styles.color` 就是 `Color`。声明成 `string` 时，「拼错的颜色」在编译期完全无声
 * —— ink 的 colorize 认不出的值会静默回退终端默认色，界面只是「颜色不对」，不报错。
 * 收紧后写错的颜色字面量当场 TS2322。
 *
 * 实测本文件 6 套主题共 132 个颜色字面量全部是合法 `#hex`，收紧不改变任何现有取值。
 */
export interface SemanticColors {
  text: {
    primary: Color;
    secondary: Color;
    link: Color;
    accent: Color;
    response: Color;
  };
  background: {
    primary: Color;
    message: Color;
    input: Color;
    focus: Color;
    diff: {
      added: Color;
      removed: Color;
      /** 词级 diff 中「变化词」的强调底色（比整行底色更深） */
      addedEmphasis: Color;
      removedEmphasis: Color;
    };
  };
  border: {
    default: Color;
  };
  ui: {
    comment: Color;
    symbol: Color;
    active: Color;
    dark: Color;
    focus: Color;
    gradient: Color[] | undefined;
  };
  status: {
    error: Color;
    success: Color;
    warning: Color;
  };
}

// 深色主题语义颜色
export const darkSemanticColors: SemanticColors = {
  text: {
    primary: "#cdd6f4",
    secondary: "#6c7086",
    link: "#89b4fa",
    accent: "#cba6f7",
    response: "#cdd6f4",
  },
  background: {
    primary: "#1e1e2e",
    message: "#181825",
    input: "#313244",
    focus: "#1e3a5f",
    diff: {
      // 2026-07: 行底色 vs 基底 #1e1e2e 原仅 1.1~1.3:1，整行像没上色。
      // 加深加浓后 add ~2.1:1 / del ~1.4:1（受红色亮度上限约束），
      // 「哪行增/删」一眼可辨；文字(status.success/error) on 底色仍 ≥5:1。
      added: "#215c33",
      removed: "#63202f",
      addedEmphasis: "#357a4b",
      removedEmphasis: "#8a2f42",
    },
  },
  border: {
    default: "#45475a",
  },
  ui: {
    comment: "#6c7086",
    symbol: "#6c7086",
    active: "#89b4fa",
    dark: "#45475a",
    focus: "#a6e3a1",
    // 蓝系单色渐变：Logo 不再紫蓝横跳，品牌色锚定在冷蓝
    gradient: ["#74a8f5", "#89b4fa", "#b4d0ff"],
  },
  status: {
    error: "#f38ba8",
    success: "#a6e3a1",
    warning: "#f9e2af",
  },
};

// ── 色盲友好（Daltonized）语义颜色 ──
// 策略：蓝(active/link) vs 蓝绿(success/focus) vs 橙(error) vs 黄(warning)，
// 四色对色盲用户均可分辨（Okabe-Ito 色板论证）。
export const daltonizedDarkSemanticColors: SemanticColors = {
  text: {
    primary: "#FFFFFF",
    secondary: "#AFAFAF",
    link: "#56B4E9", // sky blue
    accent: "#CC79A7", // reddish purple
    response: "#FFFFFF",
  },
  background: {
    primary: "#000000",
    message: "#5F5F5F",
    input: "#4A4A4A", // 比 message 深一档，可区分
    focus: "#003A5C",
    diff: {
      added: "#003A5C",
      removed: "#4A3000",
      addedEmphasis: "#005580",
      removedEmphasis: "#6B4400",
    },
  },
  border: {
    default: "#878787",
  },
  ui: {
    comment: "#AFAFAF",
    symbol: "#AFAFAF", // 与 secondary 同级（非 AccentCyan）
    active: "#56B4E9", // sky blue = 品牌色/进行中
    dark: "#878787",
    focus: "#009E73", // bluish green（与 active 蓝可分辨）
    gradient: ["#56B4E9", "#F0E442", "#E69F00"],
  },
  status: {
    error: "#E69F00", // 橙（错误/删除）
    success: "#009E73", // 蓝绿（成功，与 active 蓝区分）
    warning: "#F0E442", // 黄
  },
};

export const daltonizedLightSemanticColors: SemanticColors = {
  text: {
    primary: "#000000",
    secondary: "#5F5F5F",
    link: "#0072B2", // deep blue
    accent: "#CC79A7",
    response: "#000000",
  },
  background: {
    primary: "#FFFFFF",
    message: "#FAFAFA",
    input: "#E4E4E4",
    focus: "#CCE5FF",
    diff: {
      added: "#CCE5FF",
      removed: "#FFE0CC",
      addedEmphasis: "#99CCFF",
      removedEmphasis: "#FFCC99",
    },
  },
  border: {
    default: "#878787",
  },
  ui: {
    comment: "#5F5F5F",
    symbol: "#5F5F5F",
    active: "#0072B2", // deep blue = 品牌色
    dark: "#878787",
    focus: "#007754", // 加深 bluish green（白底对比度 ~5.5:1）
    gradient: ["#0072B2", "#9A7D0A", "#D55E00"],
  },
  status: {
    error: "#B04A00", // 加深朱橙（白底对比度 ~5.5:1）
    success: "#007754", // 加深蓝绿（白底对比度 ~5.5:1）
    warning: "#7A6300", // 加深暗黄（白底对比度 ~5.1:1）
  },
};

// GitHub Dark 语义颜色（显式定义，不走 fallback）
export const githubDarkSemanticColors: SemanticColors = {
  text: {
    primary: "#c0c4c8",
    secondary: "#6A737D",
    link: "#79B8FF",
    accent: "#B392F0",
    response: "#c0c4c8",
  },
  background: {
    primary: "#24292e",
    message: "#1f2428",
    input: "#2f363d",
    focus: "#044289",
    diff: {
      // 2026-07: 加深加浓，行底色 vs 基底 #24292e 由 ~1.2 提到 add ~1.8 / del ~1.3。
      added: "#1c5a2e",
      removed: "#6e2129",
      addedEmphasis: "#2f7d47",
      removedEmphasis: "#8a2f3a",
    },
  },
  border: {
    default: "#444d56",
  },
  ui: {
    comment: "#6A737D",
    symbol: "#6A737D", // 与 secondary 同级
    active: "#79B8FF",
    dark: "#444d56",
    focus: "#85E89D",
    gradient: ["#79B8FF", "#85E89D"],
  },
  status: {
    error: "#F97583",
    success: "#85E89D",
    warning: "#FFAB70",
  },
};

// GitHub Light 语义颜色（显式定义）
export const githubLightSemanticColors: SemanticColors = {
  text: {
    primary: "#24292e",
    secondary: "#6a737d",
    link: "#005cc5",
    accent: "#6f42c1",
    response: "#24292e",
  },
  background: {
    primary: "#ffffff",
    message: "#f6f8fa",
    input: "#e1e4e8",
    focus: "#dbeeff",
    diff: {
      // 2026-07: 白底原 add/del 底色接近纯白（~1.05:1），加深让整行可辨。
      added: "#b7ebc7",
      removed: "#f7c2c8",
      addedEmphasis: "#8dd6a3",
      removedEmphasis: "#ef9aa3",
    },
  },
  border: {
    default: "#e1e4e8",
  },
  ui: {
    comment: "#6a737d",
    symbol: "#6a737d",
    active: "#005cc5",
    dark: "#e1e4e8",
    focus: "#22863a",
    gradient: ["#005cc5", "#22863a"],
  },
  status: {
    error: "#d73a49",
    success: "#22863a",
    warning: "#c45300", // 加深橙（白底对比度 ~4.6:1）
  },
};

// 浅色主题语义颜色
// 所有文字色确保在 #eff1f5 浅背景上对比度 ≥ 4.5:1（WCAG AA）。
export const lightSemanticColors: SemanticColors = {
  text: {
    primary: "#4c4f69", // Latte text，对比度 ~7.7:1
    secondary: "#5c5f77", // subtext1 加深，对比度 ~5.5:1
    link: "#1e66f5", // 品牌蓝，对比度 ~4.3:1（大号文本 AA 达标）
    accent: "#8839ef", // mauve，对比度 ~5.8:1
    response: "#4c4f69",
  },
  background: {
    primary: "#eff1f5",
    message: "#e6e9ef",
    input: "#ccd0da",
    focus: "#dce8ff",
    diff: {
      // 2026-07: 浅底 add/del 底色原偏淡（~1.1:1），加深让整行可辨。
      added: "#b5e6c2",
      removed: "#f4c2ca",
      addedEmphasis: "#8bcfa0",
      removedEmphasis: "#e89aa6",
    },
  },
  border: {
    default: "#acb0be", // surface2，装饰性边框
  },
  ui: {
    comment: "#6c6f85", // subtext0，代码注释，对比度 ~4.4:1
    symbol: "#5c5f77", // 与 secondary 同级
    active: "#1e66f5", // 品牌蓝
    dark: "#acb0be", // surface2
    focus: "#40a02b",
    // 蓝系单色渐变（浅色对称）：与深色一致锚定品牌蓝
    gradient: ["#1e66f5", "#5a8cf8", "#8cadfb"],
  },
  status: {
    error: "#d20f39", // 对比度 ~7.8:1
    success: "#347d2a", // 加深绿，对比度 ~4.6:1（原 #40a02b 仅 ~3.0:1）
    warning: "#9a6700", // 加深棕橙，对比度 ~4.8:1（原 #df8e1d 仅 ~2.3:1）
  },
};
