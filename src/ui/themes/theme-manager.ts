/**
 * 主题管理器
 *
 * 管理内置主题和自定义主题，支持主题切换和终端背景色适配
 * 参考 gemini-cli/packages/cli/src/ui/themes/theme-manager.ts
 */

import type { Theme } from './theme.ts';
import { DefaultDark } from './builtin/dark/default-dark.ts';
import { GitHubDark } from './builtin/dark/github-dark.ts';
import { DefaultLight } from './builtin/light/default-light.ts';
import { GitHubLight } from './builtin/light/github-light.ts';
import { getThemeTypeFromBackgroundColor } from './color-utils.ts';

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

  constructor() {
    this.availableThemes = [
      DefaultDark,
      DefaultLight,
      GitHubDark,
      GitHubLight,
    ];
    this.activeTheme = DEFAULT_THEME;
  }

  setTerminalBackground(color: string | undefined): void {
    this.terminalBackground = color;
  }

  getTerminalBackground(): string | undefined {
    return this.terminalBackground;
  }

  isDefaultTheme(themeName: string | undefined): boolean {
    return (
      themeName === undefined ||
      themeName === DEFAULT_THEME.name ||
      themeName === DefaultLight.name
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
    if (process.env['NO_COLOR']) {
      // NO_COLOR 环境变量时使用默认主题
      return DEFAULT_THEME;
    }
    return this.activeTheme;
  }

  /**
   * 获取当前主题的语义颜色
   */
  getSemanticColors() {
    return this.getActiveTheme().semanticColors;
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
  isThemeCompatible(
    activeTheme: Theme,
    terminalBackground: string | undefined,
  ): boolean {
    if (activeTheme.type === 'ansi') {
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
