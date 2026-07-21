import type { UnifiedCommand } from "../../types.ts";

/**
 * /workflows 命令定义（轻量，启动时加载）。
 *
 * 查看/管理动态工作流 run。对齐 claude-code /workflows。别名 wf。
 * 无参 = 列出当前/最近 run；带 runId 或 taskId = 该 run 的进度详情。实现在 ./workflows.ts。
 */
const workflows: UnifiedCommand = {
  type: "local",
  name: "workflows",
  aliases: ["wf"],
  description: "查看动态工作流 run（无参列出；带 runId 看详情）",
  argumentHint: "[runId|taskId]",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./workflows.ts").then((m) => m.default),
};

export default workflows;
