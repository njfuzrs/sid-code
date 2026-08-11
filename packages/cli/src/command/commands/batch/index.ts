import type { UnifiedCommand } from "../../types.ts";

/**
 * /batch 命令定义（轻量，启动时加载）。对齐 claude-code §4.4。
 *
 * 把一个大任务分解为多个独立单元，各自在隔离 worktree 中并行执行。
 * 不自造执行引擎——分解与隔离并行的实体能力已由 Workflow 工具（fan-out 编排）+
 * src/worktree/ 基建提供。本命令做「结构化引导」：把用户任务转成给模型的编排指令，
 * 由模型调 Workflow/worktree 落地，避免与既有基建重复。实现在 ./batch.ts。
 */
const batch: UnifiedCommand = {
  type: "local",
  name: "batch",
  aliases: [],
  description: "把任务分解为独立单元、各自 worktree 并行执行（经 Workflow 编排）",
  argumentHint: "<要批量处理的任务>",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./batch.ts").then((m) => m.default),
};

export default batch;
