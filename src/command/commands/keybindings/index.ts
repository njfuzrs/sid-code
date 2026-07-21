import type { UnifiedCommand } from "../../types.ts";

/**
 * /keybindings 命令定义（轻量，启动时加载）。对齐 claude-code §4.3。
 *
 * 无参 → 打印 keybindings.json 路径 + 当前生效键位表 + 是否已应用用户配置。
 * init → 若文件不存在则写一份带示例的模板（照 terminal-setup 备份策略），已存在则提示路径。
 * 别名 keys。实现在 ./keybindings.ts。
 */
const keybindings: UnifiedCommand = {
  type: "local",
  name: "keybindings",
  aliases: ["keys"],
  description: "查看键位绑定 / 创建 keybindings.json 模板",
  argumentHint: "[init]",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./keybindings.ts").then((m) => m.default),
};

export default keybindings;
