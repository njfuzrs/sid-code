/**
 * UI 共享常量和工具函数
 *
 * 避免跨组件重复定义。
 */

import { ELLIPSIS } from "./constants/collapse.ts";
import { stringWidth } from "../ink/stringWidth.js";

/** 助手消息右侧留白（用于视觉区分） */
export const ASSISTANT_PADDING_RIGHT = 10;

/** header 摘要的最大显示宽度（超出截断 + ELLIPSIS，避免 header 行被长路径/命令撑爆）。 */
const SUMMARY_MAX_CHARS = 50;
/** subagent prompt 摘要的最大显示宽度（比文件/命令更短，header 只给个意向）。 */
const PROMPT_MAX_CHARS = 30;
/**
 * think 思考摘要的最大显示**列宽**（不是码点数）。
 *
 * 思考内容基本都是中文，一个字占 2 列——若沿用 SUMMARY_MAX_CHARS(50 码点) 会实际占到
 * 约 100 列，把 header 撑爆。故这里按列宽算，且走 truncateSummaryByWidth（见下）。
 */
const THINK_SUMMARY_MAX_COLS = 44;

/**
 * 按显示宽度截断摘要文本，超长则保留前 max-1 个码点 + ELLIPSIS（U+2026）。
 * 统一全项目省略号字形（对标 collapse.ts），不再用 ASCII `...`。
 */
function truncateSummary(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + ELLIPSIS : text;
}

/**
 * 按**终端列宽**截断（CJK / emoji 占 2 列），超长追加 ELLIPSIS。
 *
 * 与 truncateSummary 的区别：后者按码点数截断，对 ASCII 路径（文件路径 / shell 命令）
 * 够用；但中文文本码点数 ≈ 列宽的一半，按码点截会溢出 header。项目 L2.3 铁律要求
 * "算某段文本占几列" 一律用 stringWidth，此函数即该铁律在摘要层的落地。
 */
function truncateSummaryByWidth(text: string, maxCols: number): string {
  if (stringWidth(text) <= maxCols) return text;
  // 预留 1 列给省略号
  const budget = Math.max(1, maxCols - 1);
  let acc = "";
  let width = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (width + w > budget) break;
    acc += ch;
    width += w;
  }
  return acc + ELLIPSIS;
}

/**
 * 把多行思考压成单行摘要用的文本：折叠所有空白（含换行）为单空格。
 * header 只有一行，原样带换行会被渲染层吃掉或破坏对齐。
 */
function flattenWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * think 工具 header 的用途标签。
 *
 * 思考正文在下方结果区展示时，header 不再重复正文（短思考会一模一样），而是用这个
 * 标签回答用户的另一半疑问——「这一步到底在干什么」。原先 header 是光秃秃的
 * `⏺ think`，只有工具名，用户既不知道记了什么、也不知道它是干嘛的。
 */
export const THINK_HEADER_LABEL = "思考记录";

/**
 * 提取 think 工具记录的思考正文（原样，不截断）。
 *
 * 用途：TUI 结果区（⎿ 树枝）展示**真实思考内容**，而不是工具返回的无信息确认语
 * 「已记录思考。」。此前 header 恒为光秃秃的 `⏺ think`、结果区只有一句确认，
 * 用户完全看不出记了什么、为什么记——这是本次修复的核心（见
 * docs/_template/已记录思考的显示功能上不清晰不明确.txt）。
 *
 * 思考内容存在**工具输入**里（input.thought），展示链路一直携带 input 却从未用它。
 *
 * @returns 有内容则返回 trim 后的思考正文；非 think 工具 / 空思考返回 undefined
 *          （空思考时工具本身会回 isError，交由既有错误渲染路径处理）
 */
export function getThinkThought(name: string, input: unknown): string | undefined {
  if (name.toLowerCase() !== "think") return undefined;
  const thought = (input as any)?.thought;
  if (typeof thought !== "string") return undefined;
  const trimmed = thought.trim();
  return trimmed ? trimmed : undefined;
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
  // think：header 直接给出思考首句，让用户扫一眼就知道"这次在想什么"。
  // 此前无此分支 → 返回 "" → header 恒为光秃秃的 `⏺ think`，配上结果区那句
  // 无信息的「已记录思考。」，用户完全不知道记了什么、有什么用。
  // 按列宽截断（中文占 2 列，不能按码点数算），完整正文由结果区展示。
  if (lower === "think") {
    const thought = flattenWhitespace(inp?.thought || "");
    return thought ? truncateSummaryByWidth(thought, THINK_SUMMARY_MAX_COLS) : "";
  }
  // P0-1：单一 Skill 元工具（input={skill,args}），摘要显示 skill 名 + args
  if (lower === "skill") {
    const skillName = inp?.skill || "";
    const args = inp?.args || "";
    const short = truncateSummary(args, PROMPT_MAX_CHARS);
    if (!skillName) return "";
    return short ? `${skillName} "${short}"` : skillName;
  }
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
  // think：完整思考正文（保留换行，由展示端 wrap 呈现），不截断
  if (lower === "think") return (inp?.thought || "").trim();
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
  // think：工具 content 是无信息确认语「已记录思考。」——兜底会算出"6 字符"这种
  // 描述确认语本身、与思考内容无关的假指标。think 的真实内容在 input 里，由
  // header 摘要 + 结果区正文（getThinkThought）承担展示，此处不给冗余摘要。
  if (lower === "think") return "";
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
