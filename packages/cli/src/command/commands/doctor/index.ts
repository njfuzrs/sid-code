import type { UnifiedCommand } from "../../types.ts";

const doctorCmd: UnifiedCommand = {
  type: "local",
  name: "doctor",
  aliases: ["checkup"],
  description: "环境自检诊断（版本/运行时/配置/git/ripgrep/模型/MCP）；--disk 看磁盘占用与保留策略",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./doctor.ts").then((m) => m.default),
};

export default doctorCmd;
