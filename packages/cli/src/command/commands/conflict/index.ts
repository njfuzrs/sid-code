import type { UnifiedCommand } from "../../types.ts";

const conflict: UnifiedCommand = {
  type: "local",
  name: "conflict",
  aliases: ["cl"],
  description: "显示并发冲突状态（活跃的文件意图）",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./conflict.ts").then((m) => m.default),
};

export default conflict;
