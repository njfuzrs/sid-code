import type { UnifiedCommand } from "../../types.ts";

const doctorCmd: UnifiedCommand = {
  type: "local",
  name: "doctor",
  aliases: [],
  description: "环境自检诊断（版本/运行时/配置/git/ripgrep/模型/MCP）",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./doctor.ts").then((m) => m.default),
};

export default doctorCmd;
