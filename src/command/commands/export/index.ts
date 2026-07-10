import type { UnifiedCommand } from "../../types.ts";

const exportCmd: UnifiedCommand = {
  type: "local",
  name: "export",
  aliases: ["save"],
  description: "导出对话到剪贴板或文件",
  argumentHint: "[clipboard|file|<path>] [json|md]",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./export.ts").then((m) => m.default),
};

export default exportCmd;
