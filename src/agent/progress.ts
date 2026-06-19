/**
 * Agent 进度追踪辅助
 * 为后台 Agent 提供工具活动的文案描述。
 *
 * 注：早前这里有一个 ProgressTracker 类（updateFromMessage/getProgress），
 * 但真实进度由 agentic-loop 的 onTurnEnd 经 updateAgentProgress 直接写入
 * （tokenCount 来自 totalUsage，非估算），ProgressTracker 从未被喂数据、属死代码，已删除。
 */

/**
 * 把一次工具调用描述成简短的中文活动文案（供进度面板的「当前活动」行展示）。
 * 抽成共享函数，spawn / 进程内两条路径复用同一套文案规则。
 */
export function describeToolActivity(toolName: string, input: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case "read": return `读取 ${inp.file_path ?? ""}`;
    case "write": return `写入 ${inp.file_path ?? ""}`;
    case "edit": return `编辑 ${inp.file_path ?? ""}`;
    case "bash": return `执行 ${String(inp.command ?? "").slice(0, 60)}`;
    case "grep": return `搜索 "${inp.pattern ?? ""}"`;
    case "glob": return `查找 ${inp.pattern ?? ""}`;
    default: return toolName;
  }
}
