/**
 * Theme 类和主题类型定义
 *
 * 参考 gemini-cli/packages/cli/src/ui/themes/theme.ts
 */

import type { CSSProperties } from 'react';
import type { SemanticColors } from './semantic-tokens.ts';
import { interpolateColor, resolveColor } from './color-utils.ts';

export type ThemeType = 'light' | 'dark' | 'ansi' | 'custom';

export interface ColorsTheme {
  type: ThemeType;
  Background: string;
  Foreground: string;
  LightBlue: string;
  AccentBlue: string;
  AccentPurple: string;
  AccentCyan: string;
  AccentGreen: string;
  AccentYellow: string;
  AccentRed: string;
  DiffAdded: string;
  DiffRemoved: string;
  Comment: string;
  Gray: string;
  DarkGray: string;
  InputBackground?: string;
  MessageBackground?: string;
  FocusBackground?: string;
  FocusColor?: string;
  GradientColors?: string[];
}

// 默认不透明度常量
const DEFAULT_INPUT_BACKGROUND_OPACITY = 0.3;
const DEFAULT_SELECTION_OPACITY = 0.2;

// ── Catppuccin Latte（浅色调色板）──
// 调色板与语义色（semantic-tokens.ts lightSemanticColors）同源，
// 保证「消息流文字 / 代码块高亮 / 边框留白」共享同一色温，不再各画各的。
// 2026-07: 次要文字/注释/边框整体加深，确保浅背景下可读性（WCAG AA）。
export const lightTheme: ColorsTheme = {
  type: 'light',
  Background: '#eff1f5', // Latte base
  Foreground: '#4c4f69', // Latte text
  LightBlue: '#7287fd', // lavender
  AccentBlue: '#1e66f5', // blue（品牌色）
  AccentPurple: '#8839ef', // mauve
  AccentCyan: '#179299', // teal
  AccentGreen: '#347d2a', // 加深绿（浅底对比度 ~4.6:1）
  AccentYellow: '#9a6700', // 加深棕橙（浅底对比度 ~4.8:1）
  AccentRed: '#d20f39', // red
  DiffAdded: '#d4edda',
  DiffRemoved: '#f8d7da',
  Comment: '#6c6f85', // subtext0（代码注释，浅底对比度 ~4.4:1）
  Gray: '#5c5f77', // subtext1（次要文本，对比度 ~5.5:1）
  DarkGray: '#acb0be', // surface2（边框）
  InputBackground: '#ccd0da', // surface0
  MessageBackground: '#e6e9ef', // mantle
  FocusBackground: '#dce8ff',
  GradientColors: ['#1e66f5', '#5a8cf8', '#8cadfb'],
};

// ── Catppuccin Mocha（深色调色板）──
// 「安静的深空」：base #1e1e2e 取代刺眼纯黑，text #cdd6f4 柔白取代纯白 #FFFFFF，
// 品牌色锚定冷蓝 #89b4fa。代码块高亮 token 色直接取这里的 Accent*，与消息流同源。
export const darkTheme: ColorsTheme = {
  type: 'dark',
  Background: '#1e1e2e', // Mocha base
  Foreground: '#cdd6f4', // Mocha text（柔白，不刺眼）
  LightBlue: '#b4befe', // lavender
  AccentBlue: '#89b4fa', // blue（品牌色）
  AccentPurple: '#cba6f7', // mauve
  AccentCyan: '#94e2d5', // teal
  AccentGreen: '#a6e3a1', // green
  AccentYellow: '#f9e2af', // yellow
  AccentRed: '#f38ba8', // red
  DiffAdded: '#1e3a2e',
  DiffRemoved: '#3a1e1e',
  Comment: '#9399b2', // overlay2（代码注释，深底可读）
  Gray: '#6c7086', // overlay0（次要文本）
  DarkGray: '#45475a', // surface1（边框/竖线）
  InputBackground: '#313244', // surface0
  MessageBackground: '#181825', // mantle（比 base 略深，做代码/消息底）
  FocusBackground: '#1e3a5f',
  GradientColors: ['#74a8f5', '#89b4fa', '#b4d0ff'],
};

// ── 色盲友好（daltonized）配色 ──
// 策略：避开红/绿对立（红绿色盲最难分辨），改用「蓝=增/成功、橙=删/错误」的
// 蓝橙对比，这是色觉缺陷研究中辨识度最高的一对（Okabe-Ito / IBM 色盲安全色板）。
// 同时整行 diff 底色也用蓝橙，配合 DiffRenderer 的「加粗 + 行首 +/- 符号」双保险。

export const daltonizedDarkTheme: ColorsTheme = {
  type: 'dark',
  Background: '#000000',
  Foreground: '#FFFFFF',
  LightBlue: '#99CCFF',
  AccentBlue: '#56B4E9', // 蓝（Okabe-Ito sky blue）= 增/成功/链接强调
  AccentPurple: '#CC79A7', // 玫红（reddish purple）保留作变量色，与橙蓝均可分
  AccentCyan: '#56B4E9',
  AccentGreen: '#56B4E9', // success → 蓝
  AccentYellow: '#F0E442', // 黄（保留，色盲可辨）
  AccentRed: '#E69F00', // 橙（Okabe-Ito orange）= 删/错误，替代红
  DiffAdded: '#003A5C', // 深蓝底
  DiffRemoved: '#4A3000', // 深橙底
  Comment: '#AFAFAF',
  Gray: '#AFAFAF',
  DarkGray: '#878787',
  InputBackground: '#5F5F5F',
  MessageBackground: '#5F5F5F',
  FocusBackground: '#003A5C',
  GradientColors: ['#56B4E9', '#F0E442', '#E69F00'],
};

export const daltonizedLightTheme: ColorsTheme = {
  type: 'light',
  Background: '#FFFFFF',
  Foreground: '#000000',
  LightBlue: '#0072B2',
  AccentBlue: '#0072B2', // 深蓝（Okabe-Ito blue）= 增/成功/链接
  AccentPurple: '#CC79A7',
  AccentCyan: '#0072B2',
  AccentGreen: '#0072B2', // success → 蓝
  AccentYellow: '#9A7D0A', // 暗黄（浅底上仍可读）
  AccentRed: '#D55E00', // 朱橙（Okabe-Ito vermillion）= 删/错误
  DiffAdded: '#CCE5FF', // 浅蓝底
  DiffRemoved: '#FFE0CC', // 浅橙底
  Comment: '#5F5F5F',
  Gray: '#5F5F5F',
  DarkGray: '#5F5F5F',
  InputBackground: '#E4E4E4',
  MessageBackground: '#FAFAFA',
  FocusBackground: '#CCE5FF',
  GradientColors: ['#0072B2', '#9A7D0A', '#D55E00'],
};

export class Theme {
  /**
   * 默认前景色，当没有特定高亮规则时使用
   * 这是 Ink 兼容的颜色字符串（hex 或名称）
   */
  readonly defaultColor: string;

  /**
   * 存储从 highlight.js 类名（例如 'hljs-keyword'）到 Ink 兼容颜色字符串的映射
   */
  protected readonly _colorMap: Readonly<Record<string, string>>;
  readonly semanticColors: SemanticColors;

  /**
   * 创建新的 Theme 实例
   * @param name 主题名称
   * @param type 主题类型
   * @param rawMappings 来自 react-syntax-highlighter 主题对象的原始 CSSProperties 映射
   * @param colors 颜色主题
   * @param semanticColors 语义颜色（可选）
   */
  constructor(
    readonly name: string,
    readonly type: ThemeType,
    rawMappings: Record<string, CSSProperties>,
    readonly colors: ColorsTheme,
    semanticColors?: SemanticColors,
  ) {
    this.semanticColors = semanticColors ?? {
      text: {
        primary: this.colors.Foreground,
        secondary: this.colors.Gray,
        link: this.colors.AccentBlue,
        accent: this.colors.AccentPurple,
        response: this.colors.Foreground,
      },
      background: {
        primary: this.colors.Background,
        message:
          this.colors.MessageBackground ??
          interpolateColor(
            this.colors.Background,
            this.colors.Gray,
            DEFAULT_INPUT_BACKGROUND_OPACITY,
          ),
        input:
          this.colors.InputBackground ??
          interpolateColor(
            this.colors.Background,
            this.colors.Gray,
            DEFAULT_INPUT_BACKGROUND_OPACITY,
          ),
        focus:
          this.colors.FocusBackground ??
          interpolateColor(
            this.colors.Background,
            this.colors.FocusColor ?? this.colors.AccentGreen,
            DEFAULT_SELECTION_OPACITY,
          ),
        diff: {
          added: this.colors.DiffAdded,
          removed: this.colors.DiffRemoved,
          // 词级 diff 强调底色：在整行底色基础上向对应 accent 色加深，
          // 无独立配色时由插值派生，保证任意主题都有可用的强调色。
          addedEmphasis: interpolateColor(
            this.colors.DiffAdded,
            this.colors.AccentGreen,
            0.35,
          ),
          removedEmphasis: interpolateColor(
            this.colors.DiffRemoved,
            this.colors.AccentRed,
            0.35,
          ),
        },
      },
      border: {
        default: this.colors.DarkGray,
      },
      ui: {
        comment: this.colors.Gray,
        symbol: this.colors.AccentCyan,
        active: this.colors.AccentBlue,
        dark: this.colors.DarkGray,
        focus: this.colors.FocusColor ?? this.colors.AccentGreen,
        gradient: this.colors.GradientColors,
      },
      status: {
        error: this.colors.AccentRed,
        success: this.colors.AccentGreen,
        warning: this.colors.AccentYellow,
      },
    };
    this._colorMap = Object.freeze(this._buildColorMap(rawMappings));

    // 确定默认前景色
    const rawDefaultColor = rawMappings['hljs']?.color;
    this.defaultColor =
      (rawDefaultColor ? Theme._resolveColor(rawDefaultColor) : undefined) ??
      '';
  }

  /**
   * 获取给定 highlight.js 类名的 Ink 兼容颜色字符串
   * @param hljsClass highlight.js 类名（例如 'hljs-keyword', 'hljs-string'）
   * @returns 对应的 Ink 颜色字符串（hex 或名称），如果不存在则返回 undefined
   */
  getInkColor(hljsClass: string): string | undefined {
    return this._colorMap[hljsClass];
  }

  /**
   * 解析 CSS 颜色值为 Ink 兼容的颜色字符串
   */
  private static _resolveColor(colorValue: string): string | undefined {
    return resolveColor(colorValue);
  }

  /**
   * 从 highlight.js 类名构建到 Ink 兼容颜色字符串的内部映射
   */
  protected _buildColorMap(
    hljsTheme: Record<string, CSSProperties>,
  ): Record<string, string> {
    const inkTheme: Record<string, string> = {};
    for (const key in hljsTheme) {
      // 确保 key 以 'hljs-' 开头或是 'hljs'（基础样式）
      if (!key.startsWith('hljs-') && key !== 'hljs') {
        continue;
      }

      const style = hljsTheme[key];
      if (style?.color) {
        const resolvedColor = Theme._resolveColor(style.color);
        if (resolvedColor !== undefined) {
          inkTheme[key] = resolvedColor;
        }
      }
    }
    return inkTheme;
  }
}
