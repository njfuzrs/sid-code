import type { UnifiedCommand } from "../../types.ts";

/**
 * /color 命令定义（轻量，启动时加载）。对齐 claude-code §4.3。
 *
 * 设置 UI 强调色/品牌色（覆盖主题的 ui.active）。只点睛品牌色，不动整套配色。
 * 无参显示当前色；<hex> 设置；reset/default 清除回退主题原色。加 -p 持久化。
 * 实现在 ./color.ts。
 */
const color: UnifiedCommand = {
  type: "local",
  name: "color",
  aliases: ["accent"],
  description: "设置 UI 强调色（品牌色），reset 恢复，-p 持久化",
  argumentHint: "[#hex|reset] [-p]",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./color.ts").then((m) => m.default),
};

export default color;
