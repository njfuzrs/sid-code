/**
 * 子代理进度的呈现档位决策（纯函数层）。
 *
 * 治的问题：子代理跑 1m35s，主消息流里一个字都没有，用户完全不知道它在做什么，
 * 直到末尾一把吐出（`docs/bugfixes/todo/20260803-TUI子代理呈现四问题-对标CC根治方案.md` §3）。
 *
 * ## 与 claude-code 的关系
 *
 * 档位划分对标 cc `tools/AgentTool/UI.tsx`：
 *   - 单代理 + 屏幕够高 → 完整活动明细（cc 是嵌套真工具卡片，见下"刻意的差异"）
 *   - 屏幕不够 → collapse 成一行计数（cc `UI.tsx:469-470` 的 `rows < count*9 + 7` 判定）
 *   - 多代理并行 → 每 agent 一行 `├─ Explore (desc) · 7 tool uses · 12.4k tokens`
 *     （cc `renderGroupedAgentToolUse` / `AgentProgressLine`）
 *
 * ## 刻意的差异（不是没做到，是不该照抄）
 *
 * 1. **不嵌套真工具卡片，只渲染活动文案行。** cc 用渲染顶层工具的同一个 MessageComponent
 *    递归渲染子代理的 Read/Bash 卡片，代价是子代理的每个 content block 都作为**独立消息
 *    永久累积**进 messages（cc `REPL.tsx:2608` 明确 `NOT ephemeral`，因为它的 UI 要靠这条
 *    完整 trail 重建）。sid-code 的进度走侧信道 Map（`liveToolProgress` 形态），轮末 clear，
 *    天然无累积——这是现有架构相对 cc 的**真实优势**，为了对齐卡片形态把它改成消息累积
 *    是净亏。活动文案（`describeToolActivity`）已经能回答"在读哪个文件/搜什么"。
 * 2. **一行计数档不显示 `+N more (ctrl+o to expand)`。** 侧信道条目轮末即清，展开也没有
 *    历史可展——写了就是假承诺。完整历史在 sidechain 落盘（`sub-agent.ts` sidechainCursor）。
 *
 * 放在 `src/ui/` 的纯函数文件里而不是组件内：档位判定是本次唯一有分支逻辑的部分，
 * 写在组件闭包里就只能靠渲染快照间接测（教训见方案 §6"不可测的正确 = 下一次静默回归"）。
 */

/**
 * 单个子代理的进度快照（渲染侧视图，字段与 agent/progress.ts 的 AgentProgressSnapshot 对齐）。
 *
 * `recentActivities` 可选：拼统计行（formatAgentProgressLine）用不到它——活动列表是
 * detail 档单独逐行渲染的，不进统计行。设成必填会逼调用方为了满足类型而传一个
 * 语义上无关的字段。
 *
 * **没有 description 字段**：cc 的 perAgent 行（`├─ Explore (desc) · 7 tool uses`）需要
 * 自带描述，因为它的多代理进度汇总在**一处**渲染；本项目每个子代理有自己的工具卡片，
 * 卡片 header 已经是 `⏺ sub_agent 核查空壳清理`，进度行再带一遍描述就是同一段文字
 * 在相邻两行重复（src/ui/CLAUDE.md 明令禁止，think 渲染那次就是踩了这个）。
 */
export interface AgentProgressView {
  /** 子代理类型（explore / plan / task …） */
  agentType: string;
  toolUseCount: number;
  tokenCount: number;
  elapsedMs?: number;
  /** 最近活动文案（最新在末尾） */
  recentActivities?: string[];
}

/**
 * 呈现档位。
 * - `detail`：单代理且高度充裕 → 逐条列出最近活动
 * - `count`：高度不足 → 压成一行计数
 * - `perAgent`：多代理并行 → 每个 agent 一行
 */
export type AgentProgressTier = "detail" | "count" | "perAgent";

/**
 * 每条活动行的预估高度（行）。
 *
 * 比 cc 的 `ESTIMATED_LINES_PER_TOOL = 9` 小一个数量级，因为渲染的东西不同：cc 那 9 行是
 * 一张**完整嵌套工具卡片**（header + 结果区 + 折叠提示）的预估；这里一条活动就是一行文案，
 * 窄终端下最多折成 2 行。用 2 而不是 1 是给 CJK 文案换行留余量——预估偏大只会更早降级到
 * 一行计数（安全方向），偏小则会撑出屏幕触发全屏重打闪烁（cc 注释里 "prevents flickers
 * when the terminal size is too small" 说的正是这个）。
 */
export const ESTIMATED_LINES_PER_ACTIVITY = 2;

/**
 * 终端高度预留（行）。
 *
 * 对标 cc `TERMINAL_BUFFER_LINES = 7`：进度区不能吃满屏幕，得给输入框、状态栏、
 * 父工具卡片自己的 header 留位置。
 */
export const TERMINAL_BUFFER_LINES = 7;

/**
 * 选择呈现档位。
 *
 * @param agentCount 当前**同时在跑**的子代理数
 * @param activityCount 待展示的活动条数（单代理档才有意义）
 * @param terminalHeight 终端行数；未知（0/undefined）时按"够高"处理——
 *   拿不到高度就降级会让绝大多数正常场景吃到最差呈现，宁可赌一次换行。
 */
export function selectAgentProgressTier(
  agentCount: number,
  activityCount: number,
  terminalHeight?: number,
): AgentProgressTier {
  // 多代理并行：每个一行。这一档**不受高度影响**——它已经是"每 agent 一行"的最省形态，
  // 再降级就只剩"完全不显示"，而那正是本次要治的黑盒。
  if (agentCount > 1) return "perAgent";
  if (activityCount <= 0) return "count";
  // 高度未知 → 视为充裕（见 @param 说明）
  if (!terminalHeight || terminalHeight <= 0) return "detail";
  const needed = activityCount * ESTIMATED_LINES_PER_ACTIVITY + TERMINAL_BUFFER_LINES;
  return terminalHeight >= needed ? "detail" : "count";
}

/**
 * 格式化 token 数（`12400` → `12.4k`）。
 *
 * 与 `ui/utils/format-number.ts` 的 formatLargeNumber 保持同一口径，此处不重复实现——
 * 由调用方注入格式化函数，避免本文件为了一个数字格式反向依赖 UI utils。
 */
export type NumberFormatter = (n: number) => string;

/**
 * 拼一行进度文案（三档共用同一套统计行）。
 *
 * 形如 `explore · 7 工具 · 12.4k token · 22s`。零值字段不出现——「0 工具」「0 token」
 * 是噪音，刚起步的子代理显示 `explore · 1.2s` 更干净。与 TodoPanel 的 stats 行同一套
 * 措辞（`N 工具` / `Nk token`），避免同一份数据在面板和卡片下长成两种样子。
 */
export function formatAgentProgressLine(
  view: AgentProgressView,
  formatNumber: NumberFormatter,
  formatDuration: (ms: number) => string,
): string {
  const parts: string[] = [view.agentType];
  if (view.toolUseCount > 0) parts.push(`${view.toolUseCount} 工具`);
  if (view.tokenCount > 0) parts.push(`${formatNumber(view.tokenCount)} token`);
  if (view.elapsedMs !== undefined && view.elapsedMs > 0) {
    parts.push(formatDuration(view.elapsedMs));
  }
  return parts.join(" · ");
}
