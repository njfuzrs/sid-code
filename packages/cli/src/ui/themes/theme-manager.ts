/**
 * 主题管理器
 *
 * 管理内置主题和自定义主题，支持主题切换和终端背景色适配
 * 参考 gemini-cli/packages/cli/src/ui/themes/theme-manager.ts
 */

import type { Theme } from "./theme.ts";
import type { Color } from "@sid-code/tui-renderer/styles.ts";
import { DefaultDark } from "./builtin/dark/default-dark.ts";
import { GitHubDark } from "./builtin/dark/github-dark.ts";
import { DaltonizedDark } from "./builtin/dark/daltonized-dark.ts";
import { DefaultLight } from "./builtin/light/default-light.ts";
import { GitHubLight } from "./builtin/light/github-light.ts";
import { DaltonizedLight } from "./builtin/light/daltonized-light.ts";
import { getThemeTypeFromBackgroundColor, isValidColor, resolveColor } from "./color-utils.ts";

export const DEFAULT_THEME: Theme = DefaultDark;

export interface ThemeDisplay {
  name: string;
  type: string;
  isCustom?: boolean;
}

class ThemeManager {
  private readonly availableThemes: Theme[];
  private activeTheme: Theme;
  private terminalBackground: string | undefined;
  /** /color 强调色覆盖（hex）。非空时覆盖活动主题的品牌色 ui.active + text.accent/link。 */
  private accentOverride: Color | undefined;

  constructor() {
    this.availableThemes = [
      DefaultDark,
      DefaultLight,
      GitHubDark,
      GitHubLight,
      DaltonizedDark,
      DaltonizedLight,
    ];
    this.activeTheme = DEFAULT_THEME;
  }

  /**
   * 设置/清除 UI 强调色覆盖（/color 用）。hex=undefined 表示清除，回退主题原品牌色。
   * 因 semantic-colors.ts 的 `theme` 是 getter 代理，覆盖后组件下次读值即生效（配合重渲）。
   *
   * 内部再校验一次：调用方主要是 /color 命令（已校验+归一化），但也有 app.ts 从
   * settings.json 恢复的路径——配置文件是外部输入，可能被手改成非法值。不校验会让
   * 非法字符串一路传到 ink 的 <Text color>，色值在 colorize.ts 里静默 fallthrough
   * 不显色（实测过 bare 颜色名的同类静默失效），界面只是「颜色不对」却不报错。
   */
  setAccentOverride(hex: string | undefined): void {
    if (hex === undefined) {
      this.accentOverride = undefined;
      return;
    }
    if (!isValidColor(hex)) {
      this.accentOverride = undefined;
      return;
    }
    const resolved = resolveColor(hex) ?? hex;
    this.accentOverride = resolved as Color;
  }

  /** 当前强调色覆盖（/color 展示用）。 */
  getAccentOverride(): Color | undefined {
    return this.accentOverride;
  }

  setTerminalBackground(color: string | undefined): void {
    this.terminalBackground = color;
  }

  getTerminalBackground(): string | undefined {
    return this.terminalBackground;
  }

  isDefaultTheme(themeName: string | undefined): boolean {
    return (
      themeName === undefined || themeName === DEFAULT_THEME.name || themeName === DefaultLight.name
    );
  }

  setActiveTheme(themeName: string | undefined): boolean {
    const theme = this.findThemeByName(themeName);
    if (!theme) {
      return false;
    }
    this.activeTheme = theme;
    return true;
  }

  /**
   * 获取当前活动主题
   */
  getActiveTheme(): Theme {
    if (process.env["NO_COLOR"]) {
      // NO_COLOR 环境变量时使用默认主题
      return DEFAULT_THEME;
    }
    return this.activeTheme;
  }

  /**
   * 获取当前主题的语义颜色。
   * 若设了 accentOverride，则把品牌色相关 token（ui.active + text.accent/link）替换为覆盖色，
   * 其余 token 保持主题原值——只点睛品牌色，不动整套配色（遵守三状态体系不扩张）。
   */
  getSemanticColors() {
    const base = this.getActiveTheme().semanticColors;
    if (!this.accentOverride) return base;
    const hex = this.accentOverride;
    return {
      ...base,
      text: { ...base.text, accent: hex, link: hex },
      ui: { ...base.ui, active: hex, focus: hex },
    };
  }

  /**
   * 返回可用主题列表
   */
  getAvailableThemes(): ThemeDisplay[] {
    return this.availableThemes.map((theme) => ({
      name: theme.name,
      type: theme.type,
      isCustom: false,
    }));
  }

  /**
   * 根据名称查找主题
   */
  private findThemeByName(themeName: string | undefined): Theme | undefined {
    if (!themeName) {
      return DEFAULT_THEME;
    }
    return this.availableThemes.find((t) => t.name === themeName);
  }

  /**
   * 检查主题是否与终端背景兼容
   */
  isThemeCompatible(activeTheme: Theme, terminalBackground: string | undefined): boolean {
    if (activeTheme.type === "ansi") {
      return true;
    }

    const backgroundType = getThemeTypeFromBackgroundColor(terminalBackground);
    if (!backgroundType) {
      return true;
    }

    return activeTheme.type === backgroundType;
  }
}

export const themeManager = new ThemeManager();
