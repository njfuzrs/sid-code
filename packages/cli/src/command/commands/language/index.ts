import type { UnifiedCommand } from "../../types.ts";

/** /language 命令定义（轻量，启动时加载）。实现在 ./language.ts。 */
const language: UnifiedCommand = {
  type: "local",
  name: "language",
  aliases: ["lang"],
  description: "显示或切换输出语言偏好（-p 持久化）",
  argumentHint: "[zh|en|auto|unset|status] [-p]",
  source: "builtin",
  // T5：无头 cmdCtx 已注入 setLanguage（写 config.language + 重建系统提示词，
  // 下一轮 LLM 调用即用新语言）。无参返回 dialog（面板）= 明确失败非 0。
  headless: true,
  load: () => import("./language.ts").then((m) => new m.LanguageCommand()),
};

export default language;
