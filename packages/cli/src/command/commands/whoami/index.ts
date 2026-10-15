import type { UnifiedCommand } from "../../types.ts";

/**
 * /whoami 命令定义（轻量，启动时加载）。实现在 ./whoami.ts。
 *
 * 显示企业登录态：登录用户、登录时间、凭据过期时间、后端地址、设备 ID。
 * 没加 `/account` 别名：避免和将来的模型账户概念混淆。
 */
const whoami: UnifiedCommand = {
  type: "local",
  name: "whoami",
  aliases: [],
  description: "查看企业登录状态（--verify 向服务端核验）",
  argumentHint: "[--verify]",
  source: "builtin",
  outputPanel: true,
  userInvocable: true,
  immediate: true,
  load: () => import("./whoami.ts").then((m) => m.default),
};

export default whoami;
