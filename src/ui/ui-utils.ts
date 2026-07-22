/**
 * UI 共享常量和工具函数
 *
 * 避免跨组件重复定义。
 */

import { ELLIPSIS } from "./constants/collapse.ts";

/** 助手消息右侧留白（用于视觉区分） */
export const ASSISTANT_PADDING_RIGHT = 10;

/** header 摘要的最大显示宽度（超出截断 + ELLIPSIS，避免 header 行被长路径/命令撑爆）。 */
const SUMMARY_MAX_CHARS = 50;
/** subagent prompt 摘要的最大显示宽度（比文件/命令更短，header 只给个意向）。 */
const PROMPT_MAX_CHARS = 30;

/**
 * 按显示宽度截断摘要文本，超长则保留前 max-1 个码点 + ELLIPSIS（U+2026）。
 * 统一全项目省略号字形（对标 collapse.ts），不再用 ASCII `...`。
 */
function truncateSummary(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + ELLIPSIS : text;
}

/**
 * 判定是否子代理类工具名（供 header 摘要 / 权限框详情共用）。
 * 真实工具名是 `sub_agent`（带下划线，见 agent/tool.ts name()）——此前只判 `startsWith("subagent")`
 * （无下划线）→ `getToolSummary("sub_agent", …)` 恒返回 `""`，导致 sub_agent 卡片 header 光秃秃
 * 没有 `type "摘要"` 描述（残留时更是纯 `⏺ sub_agent`）。这里显式覆盖 `sub_agent` 与历史别名。
 */
function isSubAgentToolName(lower: string): boolean {
  return (
    lower === "sub_agent" ||
    lower.startsWith("subagent") ||
    lower.startsWith("agent__") ||
    lower.startsWith("skill__")
  );
}

/** 从工具输入中提取参数摘要（供 MessageItemRenderer / DialogManager 共用） */
export function getToolSummary(name: string, input: unknown): string {
  const inp = input as any;
  const lower = name.toLowerCase();
  if (lower === "read") {
    const fp = inp?.file_path || inp?.filePath || "";
    const offset = inp?.offset;
    const limit = inp?.limit;
    let suffix = "";
    if (offset && limit) suffix = ` (行 ${offset}-${offset + limit})`;
    else if (limit) suffix = ` (前 ${limit} 行)`;
    // 文件路径可能很长：对齐 bash 分支做显式截断（含 ELLIPSIS），不依赖 header 终端级硬截断。
    return `${truncateSummary(fp, SUMMARY_MAX_CHARS)}${suffix}`;
  }
  if (lower === "edit") return inp?.file_path || inp?.filePath || "";
  if (lower === "write") return inp?.file_path || inp?.filePath || "";
  if (lower === "bash") {
    const cmd = inp?.command || "";
    return truncateSummary(cmd, SUMMARY_MAX_CHARS);
  }
  if (lower === "grep") return `"${inp?.pattern || ""}"`;
  if (lower === "glob") return inp?.pattern || "";
  if (isSubAgentToolName(lower)) {
    const agentType = inp?.type || inp?.agentType || "";
    const prompt = inp?.prompt || inp?.task || "";
    const short = truncateSummary(prompt, PROMPT_MAX_CHARS);
    return agentType ? `${agentType} "${short}"` : short;
  }
  return "";
}

/**
 * 提取工具参数的**完整**详情（不截断），供权限确认框等需要用户看清全貌再决策的场景使用。
 *
 * 与 getToolSummary 的区别：getToolSummary 面向 header 单行摘要，对长命令/长路径做截断以免撑爆行；
 * 权限框是安全决策入口——用户要看清完整命令/路径/prompt 才能判断是否授权，绝不能截断。
 * 展示端配合 wrap="wrap" 换行呈现即可。
 */
export function getToolDetailFull(name: string, input: unknown): string {
  const inp = input as any;
  const lower = name.toLowerCase();
  if (lower === "read") {
    const fp = inp?.file_path || inp?.filePath || "";
    const offset = inp?.offset;
    const limit = inp?.limit;
    let suffix = "";
    if (offset && limit) suffix = ` (行 ${offset}-${offset + limit})`;
    else if (limit) suffix = ` (前 ${limit} 行)`;
    return `${fp}${suffix}`;
  }
  if (lower === "edit" || lower === "write") return inp?.file_path || inp?.filePath || "";
  if (lower === "bash") return inp?.command || "";
  if (lower === "grep") return `"${inp?.pattern || ""}"`;
  if (lower === "glob") return inp?.pattern || "";
  if (isSubAgentToolName(lower)) {
    const agentType = inp?.type || inp?.agentType || "";
    const prompt = inp?.prompt || inp?.task || "";
    return agentType ? `${agentType} "${prompt}"` : prompt;
  }
  // 兜底：回退到摘要（覆盖不到的工具类型仍有信息展示）
  return getToolSummary(name, input);
}

/** 从工具结果中提取结果摘要 */
export function getResultSummary(name: string, content: string, isError?: boolean): string {
  if (isError) return truncateSummary(content, 60);
  const lower = name.toLowerCase();
  if (lower === "read") return `${content.split("\n").length} 行`;
  if (lower === "edit") return "替换完成";
  if (lower === "write") return `${content.length} 字符`;
  if (lower === "bash") return `${content.split("\n").length} 行输出`;
  if (lower === "grep") return `${content.trim().split("\n").filter(l => l.length > 0).length} 个结果`;
  if (lower === "glob") return `${content.trim().split("\n").filter(l => l.length > 0).length} 个文件`;
  return `${content.length} 字符`;
}

/** 检测工具结果是否为 diff 格式 */
export function isDiffContent(name: string, content: string): boolean {
  const lower = name.toLowerCase();
  // Edit / Write 工具成功后会在 output 中附带标准 unified diff。
  // 统一以「是否含 @@ hunk 头」为判定依据(parseDiffWithLineNumbers 也以此解析)。
  if (lower === "edit" || lower === "write") {
    return /^@@ -\d/m.test(content);
  }
  return false;
}

/** 从工具输入中提取文件名（用于 diff 语法高亮） */
export function getFilenameFromInput(name: string, input: unknown): string | undefined {
  const lower = name.toLowerCase();
  if (lower === "edit" || lower === "write" || lower === "read") {
    const inp = input as any;
    return inp?.file_path || inp?.filePath;
  }
  return undefined;
}
