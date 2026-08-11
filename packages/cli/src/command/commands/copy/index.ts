import type { UnifiedCommand } from "../../types.ts";

/**
 * /copy 命令定义（轻量，启动时加载）。
 *
 * 复制最后一条助手回复到系统剪贴板。对齐 claude-code /copy。
 * 无参 = 复制最后一条 assistant 文本；code = 只复制其中的代码块。实现在 ./copy.ts。
 */
const copy: UnifiedCommand = {
  type: "local",
  name: "copy",
  aliases: [],
  description: "复制最后一条助手回复到剪贴板（code 只复制代码块）",
  argumentHint: "[code]",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./copy.ts").then((m) => m.default),
};

export default copy;
