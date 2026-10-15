import type { UnifiedCommand } from "../../types.ts";

/**
 * /logout 命令定义（轻量，启动时加载）。实现在 ./logout.ts。
 * 登出企业后端：通知后端解绑本设备并删本地凭据，等价于 `sid-code logout`。
 */
const logout: UnifiedCommand = {
  type: "local",
  name: "logout",
  aliases: [],
  description: "登出企业后端：通知后端解绑本设备并删除本地凭据",
  source: "builtin",
  userInvocable: true,
  immediate: true,
  load: () => import("./logout.ts").then((m) => m.default),
};

export default logout;
