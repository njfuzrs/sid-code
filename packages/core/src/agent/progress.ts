/**
 * Agent 进度追踪辅助
 * 为后台 Agent 提供工具活动的文案描述。
 *
 * 注：早前这里有一个 ProgressTracker 类（updateFromMessage/getProgress），
 * 但真实进度由 agentic-loop 的 onTurnEnd 经 updateAgentProgress 直接写入
 * （tokenCount 来自 totalUsage，非估算），ProgressTracker 从未被喂数据、属死代码，已删除。
 */

/**
 * 「最近活动」滑动窗口容量（对标 claude-code `MAX_PROGRESS_MESSAGES_TO_SHOW = 3`）。
 *
 * 3 条是"看得出在干什么"与"不淹没消息流"的平衡点：子代理跑 20 轮，全列出来就是
 * 第二个消息流；只留 1 条又看不出推进方向（同一个文件读三次和读三个不同文件，
 * 单条快照分辨不出）。更早的活动不做 `+N` 提示——它们已经作为父工具卡片下的
 * 历史滚过去了，且完整历史在 sidechain 落盘可查。
 */
export const MAX_RECENT_ACTIVITIES = 3;

/**
 * 子代理进度快照（回灌父工具卡片的数据契约）。
 *
 * 只承载**渲染需要的最小集合**，不带 messages/工具入参原文：这条数据每轮都往 UI 推一次，
 * 塞大字段等于按轮次复制上下文。真正的完整历史走 sidechain 落盘（见 sub-agent.ts
 * 的 sidechainCursor），两者分工——这里管"实时看得见"，那里管"事后查得到"。
 */
export interface AgentProgressSnapshot {
  /** 子代理类型（explore / plan / task …），用于并行时区分是哪个 agent 的进度 */
  agentType: string;
  /** 累计工具调用次数（来自 runAgentLoop 实计，非估算） */
  toolUseCount: number;
  /** 累计 token（来自 totalUsage，非估算） */
  tokenCount: number;
  /** 已耗时（毫秒），由子代理侧按 startTime 实算 */
  elapsedMs?: number;
  /** 最近若干条工具活动文案（最新在末尾，容量见 MAX_RECENT_ACTIVITIES） */
  recentActivities: string[];
}

/** 子代理进度事件（经工具 onProgress 通道回灌到父工具卡片）。 */
export interface AgentProgressEvent extends AgentProgressSnapshot {
  type: "agent_progress";
}

/**
 * 把一条新活动推入滑动窗口，返回**新数组**（不原地改入参）。
 *
 * 返回新数组而非 push：这个数组会被塞进 registry 的 AgentProgress 并被 UI 读取，
 * 原地 push 会让"上一帧的快照"跟着变，React 侧靠引用判断有无更新时就失去分辨力。
 *
 * 连续重复的活动**合并而不追加**（cc 那边这个合并被 `if ("external" !== 'ant') return`
 * 死掉了，外部用户看到的是每个操作各占一行）：子代理连续读 5 个文件时，"读取 a / 读取 b /
 * 读取 c"三条有信息量；但同一条文案连续出现（如轮次间无新工具、lastActivity 未变）
 * 重复列出只是噪音。判据是**与窗口末尾逐字相同**，不做同类操作归并——"读取 a"与
 * "读取 b"是两件事，合并会丢掉"读了哪些"这个用户真正想知道的信息。
 */
export function pushRecentActivity(
  activities: readonly string[],
  activity: string,
  max = MAX_RECENT_ACTIVITIES,
): string[] {
  if (!activity) return [...activities];
  // 与末尾逐字相同 → 视为同一件事仍在继续，不追加
  if (activities.length > 0 && activities[activities.length - 1] === activity) {
    return [...activities];
  }
  const next = [...activities, activity];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * 把一次工具调用描述成简短的中文活动文案（供进度面板的「当前活动」行展示）。
 * 抽成共享函数，spawn / 进程内两条路径复用同一套文案规则。
 */
export function describeToolActivity(toolName: string, input: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case "read":
      return `读取 ${inp.file_path ?? ""}`;
    case "write":
      return `写入 ${inp.file_path ?? ""}`;
    case "edit":
      return `编辑 ${inp.file_path ?? ""}`;
    case "bash":
      return `执行 ${String(inp.command ?? "").slice(0, 60)}`;
    case "grep":
      return `搜索 "${inp.pattern ?? ""}"`;
    case "glob":
      return `查找 ${inp.pattern ?? ""}`;
    default:
      return toolName;
  }
}
