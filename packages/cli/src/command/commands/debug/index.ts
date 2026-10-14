import type { UnifiedCommand } from "../../types.ts";

const debug: UnifiedCommand = {
  type: "local",
  name: "debug",
  aliases: ["diag"],
  description:
    "调试信息：显示诊断数据、复制 Session ID；配了 trace.upload 时立即上传当前轨迹到你配置的地址",
  source: "builtin",
  outputPanel: true,
  userInvocable: true,
  immediate: true,
  load: () => import("./debug.ts").then((m) => m.default),
};

export default debug;
