import type { UnifiedCommand } from "../../types.ts";

/** /permissions 命令定义（轻量，启动时加载）。实现在 ./permissions.ts。 */
const permissions: UnifiedCommand = {
  type: "local",
  name: "permissions",
  aliases: ["perms"],
  description: "查看当前权限规则和模式",
  source: "builtin",
  outputPanel: true,
  load: () => import("./permissions.ts").then((m) => new m.PermissionsCommand()),
};

export default permissions;
