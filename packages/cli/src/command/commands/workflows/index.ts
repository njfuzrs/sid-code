import type { UnifiedCommand } from "../../types.ts";

/**
 * /workflows 命令定义（轻量，启动时加载）。
 *
 * 查看/管理动态工作流 run。对齐 claude-code /workflows。别名 wf。
 * 无参 = 列出当前会话 run + 磁盘 journal 里的历史 run；带 runId 或 taskId = 该 run 的进度详情
 * （内存查不到时回退读磁盘 journal）。实现在 ./workflows.ts。
 */
const workflows: UnifiedCommand = {
  type: "local",
  name: "workflows",
  aliases: ["wf"],
  description: "查看动态工作流 run（无参列出；带 runId 看详情）",
  argumentHint: "[runId|taskId]",
  source: "builtin",
  outputPanel: true,
  userInvocable: true,
  immediate: true,
  load: () => import("./workflows.ts").then((m) => m.default),
};

export default workflows;
