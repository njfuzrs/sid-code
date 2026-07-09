import type { UnifiedCommand } from "../../types.ts";

const debug: UnifiedCommand = {
  type: "local",
  name: "debug",
  aliases: ["diag"],
  description: "调试信息：上传当前轨迹快照、显示诊断数据、复制 Session ID",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./debug.ts").then((m) => m.default),
};

export default debug;
