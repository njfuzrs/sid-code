import type { UnifiedCommand } from "../../types.ts";

/** /allow 命令定义（轻量，启动时加载）。实现在 ./allow.ts。 */
const allow: UnifiedCommand = {
  type: "local",
  name: "allow",
  aliases: [],
  description: "添加 allow 权限规则（默认当前会话，-p 持久化）",
  argumentHint: "<规则> [-p] [--scope user|project]",
  source: "builtin",
  immediate: true,
  requiresArgs: true,
  load: () => import("./allow.ts").then((m) => new m.AllowCommand()),
};

export default allow;
