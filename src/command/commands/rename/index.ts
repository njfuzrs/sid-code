import type { UnifiedCommand } from "../../types.ts";

/**
 * /rename 命令定义（轻量，启动时加载）。
 *
 * 重命名当前会话。对齐 claude-code /rename。
 * 带参 = 用指定名字；无参 = 基于最近用户消息启发式生成。实现在 ./rename.ts。
 */
const rename: UnifiedCommand = {
  type: "local",
  name: "rename",
  aliases: [],
  description: "重命名当前会话（无参则据上下文自动生成名字）",
  argumentHint: "[新名字]",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./rename.ts").then((m) => m.default),
};

export default rename;
