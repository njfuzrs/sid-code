// 语义颜色动态代理对象
// 参考 gemini-cli/packages/cli/src/ui/semantic-colors.ts

import { themeManager } from "./themes/theme-manager.js";
import type { SemanticColors } from "./themes/semantic-tokens.js";

export const theme: SemanticColors = {
  get text() {
    return themeManager.getSemanticColors().text;
  },
  get background() {
    return themeManager.getSemanticColors().background;
  },
  get border() {
    return themeManager.getSemanticColors().border;
  },
  get ui() {
    return themeManager.getSemanticColors().ui;
  },
  get status() {
    return themeManager.getSemanticColors().status;
  },
};
