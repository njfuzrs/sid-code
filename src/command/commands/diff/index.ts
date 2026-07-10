import type { UnifiedCommand } from "../../types.ts";

const diffCmd: UnifiedCommand = {
  type: "local",
  name: "diff",
  aliases: [],
  description: "显示当前工作区 git diff（--staged 看已暂存改动）",
  argumentHint: "[--staged|--cached]",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./diff.ts").then((m) => m.default),
};

export default diffCmd;
