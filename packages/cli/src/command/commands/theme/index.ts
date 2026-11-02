import type { UnifiedCommand } from "../../types.ts";

/** /theme 命令定义（轻量，启动时加载）。实现在 ./theme.ts。 */
const theme: UnifiedCommand = {
  type: "local",
  name: "theme",
  aliases: [],
  description: "显示或切换主题（-p 持久化）",
  argumentHint: "[name|list] [-p]",
  source: "builtin",
  immediate: true,
  load: () => import("./theme.ts").then((m) => new m.ThemeCommand()),
};

export default theme;
