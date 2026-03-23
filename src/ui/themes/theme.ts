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
const DEFAULT_BACKGROUND_OPACITY = 0.15;
const DEFAULT_SELECTION_OPACITY = 0.2;
const DEFAULT_BORDER_OPACITY = 0.5;

export const lightTheme: ColorsTheme = {
  type: 'light',
  Background: '#FFFFFF',
  Foreground: '#000000',
  LightBlue: '#005FAF',
  AccentBlue: '#005FAF',
  AccentPurple: '#5F00FF',
  AccentCyan: '#005F87',
  AccentGreen: '#005F00',
  AccentYellow: '#875F00',
  AccentRed: '#AF0000',
  DiffAdded: '#D7FFD7',
  DiffRemoved: '#FFD7D7',
  Comment: '#008700',
  Gray: '#5F5F5F',
  DarkGray: '#5F5F5F',
  InputBackground: '#E4E4E4',
  MessageBackground: '#FAFAFA',
  FocusBackground: '#D7FFD7',
  GradientColors: ['#4796E4', '#847ACE', '#C3677F'],
};

export const darkTheme: ColorsTheme = {
  type: 'dark',
  Background: '#000000',
  Foreground: '#FFFFFF',
  LightBlue: '#AFD7D7',
  AccentBlue: '#87AFFF',
  AccentPurple: '#D7AFFF',
  AccentCyan: '#87D7D7',
  AccentGreen: '#D7FFD7',
  AccentYellow: '#FFFFAF',
  AccentRed: '#FF87AF',
  DiffAdded: '#005F00',
  DiffRemoved: '#5F0000',
  Comment: '#AFAFAF',
  Gray: '#AFAFAF',
  DarkGray: '#878787',
  InputBackground: '#5F5F5F',
  MessageBackground: '#5F5F5F',
  FocusBackground: '#005F00',
  GradientColors: ['#4796E4', '#847ACE', '#C3677F'],
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
