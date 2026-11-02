import type { UnifiedCommand } from "../../types.ts";

/** /deny 命令定义（轻量，启动时加载）。实现在 ./deny.ts。 */
const deny: UnifiedCommand = {
  type: "local",
  name: "deny",
  aliases: [],
  description: "添加 deny 权限规则（默认当前会话，-p 持久化）",
  argumentHint: "<规则> [-p] [--scope user|project]",
  source: "builtin",
  immediate: true,
  requiresArgs: true,
  load: () => import("./deny.ts").then((m) => new m.DenyCommand()),
};

export default deny;
