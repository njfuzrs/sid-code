// 主题管理器
// 参考 gemini-cli/packages/cli/src/ui/themes/theme-manager.ts（简化版）

import type { SemanticColors } from './semantic-tokens.js';
import { darkSemanticColors, lightSemanticColors } from './semantic-tokens.js';

export type ThemeType = 'dark' | 'light' | 'auto';

class ThemeManager {
  private activeTheme: ThemeType = 'dark';
  private terminalBackground: string | undefined;

  setTheme(theme: ThemeType): void {
    this.activeTheme = theme;
  }

  getTheme(): ThemeType {
    return this.activeTheme;
  }

  setTerminalBackground(color: string | undefined): void {
    this.terminalBackground = color;
  }

  // 根据终端背景色判断深浅
  private detectThemeFromBackground(): 'dark' | 'light' {
    if (!this.terminalBackground) return 'dark';
    // 简单亮度判断：解析 hex 颜色
    const hex = this.terminalBackground.replace('#', '');
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      // 相对亮度公式
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      return luminance > 128 ? 'light' : 'dark';
    }
    return 'dark';
  }

  getSemanticColors(): SemanticColors {
    const resolved =
      this.activeTheme === 'auto'
        ? this.detectThemeFromBackground()
        : this.activeTheme;
    return resolved === 'light' ? lightSemanticColors : darkSemanticColors;
  }
}

export const themeManager = new ThemeManager();
