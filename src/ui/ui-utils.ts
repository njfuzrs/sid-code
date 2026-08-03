/**
 * UI 共享常量和工具函数
 *
 * 避免跨组件重复定义。
 */

import { ELLIPSIS } from "./constants/collapse.ts";
import { stringWidth } from "../ink/stringWidth.js";
import { shortenPathForDisplay, stripPathNoiseInText } from "./utils/path-display.ts";

/** 助手消息右侧留白（用于视觉区分） */
export const ASSISTANT_PADDING_RIGHT = 10;

/**
 * header 摘要的**上限**（码点数），只作为防御性护栏，不再是常规截断点。
 *
 * 历史问题（本次修复）：这里曾是 50，且是唯一的截断关口——不看终端宽度就把摘要砍到 50 码点，
 * 于是 120 列的终端上右侧一大片空白闲着，被砍掉的却是关键信息：
 *   `⏺ read /Users/dev/Code/person/sid-code/docs/bugf…`
 * 真正该按终端宽度收缩的职责已移交视图层（`ToolShared.tsx` 的 `ToolInfo` → `fitPathToWidth`），
 * 数据层只负责去掉 cwd/home 噪音前缀（`shortenPathForDisplay`）。
 *
 * 这个上限保留的意义：命令/prompt 可能是几 KB 的巨串，直接塞进 React 树没必要——
 * 先砍到一个「任何终端都用不完」的量级（240 列 ≈ 超宽屏），再交给视图层按真实宽度精修。
 */
const SUMMARY_MAX_CHARS = 240;
/** subagent prompt 摘要的上限（同为护栏，实际收缩在视图层按列宽做）。 */
const PROMPT_MAX_CHARS = 240;
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
    // 只去 cwd/home 噪音前缀，**不截断**：按终端宽度收缩是视图层的事（ToolInfo → fitPathToWidth）。
    // 此前这里按 50 码点尾截断，砍掉的恰是唯一有区分度的文件名，保留的是每行都一样的前缀。
    return `${shortenPathForDisplay(fp)}${suffix}`;
  }
  if (lower === "edit") return shortenPathForDisplay(inp?.file_path || inp?.filePath || "");
  if (lower === "write") return shortenPathForDisplay(inp?.file_path || inp?.filePath || "");
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
  // lsp：header 必须回答"在查什么"——操作名 + 文件 + 位置。
  //
  // 此前无此分支 → 返回 "" → header 恒为光秃秃的 `⏺ lsp`。而 LSP 的等待是**隐形的长**：
  // waitForLSPReady 默认等 10s（lsp/manager.ts）、语言服务器冷启动、单请求超时 30s
  // （lsp/client.ts），期间屏幕上只有 `⏺ lsp` 三个字，用户完全不知道在查哪个文件的什么符号
  // （见 docs/_template/执行lsp过程空白.txt）。这是本文件同一病灶的第三次发作
  // （前两次：sub_agent 名字没匹配上、think 没有分支）。
  if (lower === "lsp") return lspSummary(inp);
  if (isSubAgentToolName(lower)) {
    const agentType = inp?.type || inp?.agentType || "";
    const prompt = inp?.prompt || inp?.task || "";
    // 先剥掉 prompt 里内嵌的 cwd/home 绝对路径再上限护栏：这段路径对同批 fan-out 的每个
    // 子代理都一模一样，会把 header 列宽吃光，导致 5 个并行子代理的卡片截断后长得一样、
    // 完全分不清谁在干什么（截图里的第二个症状）。
    const short = truncateSummary(
      stripPathNoiseInText(flattenWhitespace(prompt)),
      PROMPT_MAX_CHARS,
    );
    return agentType ? `${agentType} "${short}"` : short;
  }
  return "";
}

/**
 * lsp header 摘要：`operation 相对路径:行:列`。
 *
 * 两个取舍：
 *
 *   1. **operation 放最前面**，且 lsp **不进** `isPathDescriptionTool` 名单（即按"文本"从
 *      尾部收缩，不按"路径"从头部收缩）。因为 lsp 的 description 是**混合形态**
 *      （操作名 + 路径），若按路径处理，`fitPathToWidth` 会按 `/` 切段只保尾部，
 *      把最关键的 operation 整个砍掉，收缩出 `…/lsp.ts:100:5` 这种看不出在干什么的结果。
 *      操作名是 LSP 卡片的信息重心（"跳定义"还是"查引用"决定了用户在看什么），必须保住。
 *   2. 路径走 `shortenPathForDisplay` 转相对路径（与 read/edit/write 一致），不在数据层
 *      截断——截断是视图层按真实列宽的事。相对化之后路径本身已经很短
 *      （`src/tool/lsp.ts`），混合形态在常规终端宽度下放得下。
 */
function lspSummary(inp: any): string {
  const op = inp?.operation || "";
  // workspaceSymbol 的信息重心是搜索词，不是文件（file_path 只用于定位语言服务器）
  if (op === "workspaceSymbol") {
    const q = inp?.query || "";
    return q ? `${op} "${truncateSummary(q, PROMPT_MAX_CHARS)}"` : op;
  }
  const fp = shortenPathForDisplay(inp?.file_path || inp?.filePath || "");
  const pos = inp?.line != null && inp?.character != null ? `:${inp.line}:${inp.character}` : "";
  if (!op) return fp ? `${fp}${pos}` : "";
  if (!fp) return op;
  return `${op} ${fp}${pos}`;
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
  // lsp：权限框要看清**完整绝对路径**（授权决策依据），不能用相对化/截断后的形式。
  // 与 getToolSummary 的 lsp 分支成对——此前两个函数都缺 lsp，是同一个漏登记的两面。
  if (lower === "lsp") {
    const op = inp?.operation || "";
    if (op === "workspaceSymbol") {
      const q = inp?.query || "";
      return q ? `${op} "${q}"` : op;
    }
    const fp = inp?.file_path || inp?.filePath || "";
    const pos = inp?.line != null && inp?.character != null ? `:${inp.line}:${inp.character}` : "";
    if (!op) return fp ? `${fp}${pos}` : "";
    if (!fp) return op;
    return `${op} ${fp}${pos}`;
  }
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
  // lsp：兜底的"N 字符"对代码智能结果毫无意义（用户关心"找到几处"，不关心输出多长）。
  // LSP 各 formatter（tool/lsp-formatters.ts）的成功输出都是「一行一条结果」，
  // 空结果则是「未找到…」/「无可用…」这类整句话。按此分流。
  if (lower === "lsp") return lspResultSummary(content);
  return `${content.length} 字符`;
}

/**
 * lsp 结果摘要：把"输出多长"换成"找到几处"。
 *
 * 判空不靠"内容里有没有某个关键词"（formatter 的文案会漂移，一改就静默失效），
 * 而是靠**结构特征**：LSP 的结果行统一形如 `path:line:col` 或以列表符号开头，
 * 空结果则是单句自然语言。故只要"首行不含 `:数字`"就按空结果处理。
 */
function lspResultSummary(content: string): string {
  const lines = content
    .trim()
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "";

  // 「共 N 处，仅显示前 50 处」这类统计尾注：直接采信它给的真实总数
  const totalMatch = content.match(/共\s*(\d+)\s*处/);
  if (totalMatch) return `${totalMatch[1]} 处`;

  // 空结果整句（「未找到定义」/「无可用的代码修复建议（…）」/「此位置无可用的调用层级项（…）」）：
  // 结构上不含 `:行号`，原样透出这句话本身——它已经是最准确的摘要。
  const hasPositionRef = /:\d+/.test(lines[0]!);
  if (!hasPositionRef && lines.length === 1) return truncateSummary(lines[0]!, 40);

  return `${lines.length} 处`;
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
