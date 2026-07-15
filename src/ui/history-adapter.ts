/**
 * LLM Message → HistoryItem 适配层
 *
 * 在 agent loop 产出消息时将 LLM Message 转换为 HistoryItem，
 * 而非在渲染时解析。这样 UI 层只需按 type 字段 switch 分发即可。
 *
 * 核心设计：
 * - tool_use（assistant）和 tool_result（user）合并为单条 ToolGroup 记录
 * - 维护全局 toolNameMap 解决增量同步时 "unknown" 工具名问题
 */

import {
  type HistoryItem,
  type HistoryItemWithoutId,
  type IndividualToolCallDisplay,
  ToolCallStatus,
  type ToolResultDisplay,
} from "./types.ts";
import type { Message } from "../llm/types.ts";
import { getToolSummary, getResultSummary, isDiffContent, getFilenameFromInput } from "./ui-utils.ts";
// 直接复用产生端的 origin 常量,而非在此重复字符串字面量——避免"注入端打了 origin、
// 隐藏端白名单漏登记"的漂移(compact-reattach 泄漏正是此类接线遗漏)。
import { hasInternalOrigin as hasInternalOriginImpl } from "../context/internal-message.ts";

/**
 * 构建主屏 Static 模式的历史项数组（ADR-040）。
 *
 * - 空历史 → 空数组（不插 header，让 EmptyLogo 显示）
 * - 非空 → 顶部插入一个 app_header，其后接全部已完成历史项
 *
 * 关键不变量：返回结果**绝不包含流式虚拟项**（STREAMING_ITEM_ID）。
 * 流式内容在 MainScreenLayout 动态区单独渲染，流式完成后才并入 historyItems，
 * 届时本函数才把它纳入 Static（保证一条消息要么在动态区要么在 Static，不重叠）。
 */
export function buildStaticItems(historyItems: HistoryItem[], version: string): HistoryItem[] {
  if (historyItems.length === 0) return [];
  return [
    { id: -2, type: "app_header", version } as HistoryItem,
    ...historyItems,
  ];
}

/**
 * 判断一个历史项是否为"执行中"的活项（含尚未完成的工具调用）。
 *
 * `messagesToHistoryItems` 在 tool_use 已入 ctxMgr、tool_result 尚未到达的中间窗口，
 * 会把该 tool_use 输出为 status=executing 的 tool_group（P2-1 语义：并行多工具时
 * 逐个可见）。这类活项**绝不能进 `<Static>`**——Static 一次性打印进终端 scrollback，
 * `log-update` 的 cell diff 只能擦视口内的行、擦不掉已滚出视口的 scrollback 行；
 * 于是每次 syncDisplay 重建出的 executing 中间态一旦溢出视口，就永久残留
 *（现象：屏幕底部堆积 `⏺ task_list` / `⏺ task_output` 之类无 `⎿` 结果的幽灵行）。
 */
export function isLiveToolItem(item: HistoryItem): boolean {
  return (
    item.type === "tool_group" &&
    item.tools.some(t => t.status === ToolCallStatus.Executing)
  );
}

/**
 * 把历史项拆成「已终结(committed)」与「执行中(live)」两部分。
 *
 * - committed：状态已固化（工具全部 success/error/cancelled，或非工具项）→ 可安全进
 *   `<Static>` → scrollback，永不重写。
 * - live：含 executing 工具的活项 → 交由动态区（log-update 每帧重绘、永不提交 scrollback）
 *   渲染，工具一旦完成，下一帧它会以终态并入 committed，动态区自然清空。
 *
 * 保持原有相对顺序。这是纯数据拆分，不改 `messagesToHistoryItems` 的产出（那 5 个
 * pending→executing 单测锁定的纯函数行为保持不变），只在消费端决定"进 Static 还是进动态区"。
 */
export function splitLiveToolItems(historyItems: HistoryItem[]): {
  committed: HistoryItem[];
  live: HistoryItem[];
} {
  const committed: HistoryItem[] = [];
  const live: HistoryItem[] = [];
  for (const item of historyItems) {
    if (isLiveToolItem(item)) live.push(item);
    else committed.push(item);
  }
  return { committed, live };
}

/**
 * shell 工具名判定（与 ToolShared.tsx 的 isShellTool 同义）。
 * 此处按行数估算需要，故本地复制这 3 行纯逻辑，避免 history-adapter（纯数据层）
 * 依赖 ToolShared.tsx（React 组件层），防止引入不必要的渲染层耦合。
 */
function isShellToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "bash" || lower === "shell" || lower === "execute_command";
}

/**
 * shell 实时输出在行数预算里的上限。与 bash 侧 PROGRESS_TAIL_LINES（当前 5）一致，
 * 但独立定义于此：即使上游 tail 调大，估算高度也不失控。取 5 使单个 shell 活项估算
 * ≈ 2 + 5 = 7 行，capLiveToolItems 预算门槛降到 rows≥21，覆盖多数分屏终端。
 */
const SHELL_PROGRESS_ROW_CAP = 5;

/**
 * 估算单个 executing 态工具在动态区占用的终端行数（对齐 ToolMessage 的实际渲染）：
 * - shell 工具 + 实时输出：header + 命令行 + 进度尾部各行（ToolMessage 逐行渲染 progressMessage），
 *   按 2 + 进度行数估算；
 * - shell 工具无实时输出：header + 独立命令行区 ≈ 2 行（窄终端命令截断时还会多 1 行摘要，故按 2 起）；
 * - 带 MCP 进度消息的工具：header + 进度行 ≈ 2 行；
 * - 普通工具：仅 header ≈ 1 行。
 * 宁可略高估（多截、少显示）也不能低估——低估会让视口封顶偏松、动态区溢出 scrollback（幽灵行残留）。
 */
function estimateToolRows(tool: { name: string; progressMessage?: string }): number {
  if (isShellToolName(tool.name)) {
    // shell 实时输出逐行渲染在命令行下方（见 ToolMessage.shellLiveOutputSection）：
    // header(1) + 命令行(1) + progressMessage 的行数。progressMessage 缺省时按 2 起。
    // 进度行数设上限 SHELL_PROGRESS_ROW_CAP：与 bash 侧 PROGRESS_TAIL_LINES 解耦，即使
    // 上游 tail 调大，单个 shell 活项的估算高度也不会失控挤占其它并发工具的动态区预算。
    if (tool.progressMessage) {
      const progressLines = Math.min(
        tool.progressMessage.split("\n").length,
        SHELL_PROGRESS_ROW_CAP,
      );
      return 2 + progressLines;
    }
    return 2;
  }
  if (tool.progressMessage) return 2;
  return 1;
}

/**
 * 估算一个 live 活项在动态区占用的终端行数。
 * tool_group 累加组内每个工具的估算行数（executing 态结果行尚未到达，按 header/命令/进度估）。
 * 用于 `capLiveToolItems` 的预算累计。
 */
function estimateLiveItemRows(item: HistoryItem): number {
  if (item.type === "tool_group") {
    return Math.max(1, item.tools.reduce((sum, t) => sum + estimateToolRows(t), 0));
  }
  return 1;
}

/**
 * 统计一个 live 活项包含的**工具个数**（供「另有 N 个工具执行中」摘要文案）。
 * tool_group 计组内 tools 数，其它活项计 1。与 estimateLiveItemRows（行数预算）区分：
 * 预算算行数、摘要算工具数，二者语义不同不可混用。
 */
function countLiveItemTools(item: HistoryItem): number {
  if (item.type === "tool_group") {
    return Math.max(1, item.tools.length);
  }
  return 1;
}

/**
 * 对动态区的 live 工具活项按视口行数预算做**尾部封顶**，根治幽灵行残留。
 *
 * 根因（见 `isLiveToolItem` 注释 + src/ui/CLAUDE.md L3.4）：live 活项虽已从 `<Static>`
 * 剥到动态区渲染，但动态区同样受 `log-update` 物理限制——它只能擦"当前视口内"的行，
 * 擦不掉溢出到 scrollback 的行（log-update.ts:262-266）。并行多工具（如 6 子代理 +
 * 一堆并行 read/grep）时 live 活项一次十几行，动态区高度超过视口 → 早期 executing 行
 * 溢出 scrollback → 工具完成后终态并入 Static，但那些旧的 executing 幽灵行永久擦不掉。
 *
 * 修复不变量：**动态区的 live 活项高度永不超过给定预算** → 永远落在视口内 → log-update
 * 永远擦得掉 → 无 scrollback 残留。
 *
 * 策略：保留**尾部**（最近发起的工具最相关、最可能仍在跑），累计估算行数不超过 `maxRows`；
 * 超出的用调用侧的一行摘要「… +N 个工具执行中」代替（对齐 L3.3 折叠规范：显示摘要而非
 * 完全隐藏）。maxRows ≤ 0 时退化为"全隐藏 + 全部计入摘要"（极小终端兜底，不渲染任何活项）。
 *
 * @param live 已由 `splitLiveToolItems` 拆出的 live 活项（保持原始相对顺序）
 * @param maxRows 动态区分配给 live 活项的最大行数预算（由视口高度派生，见 App.tsx）
 * @returns visible 保留渲染的活项（原始顺序）；hiddenToolCount 被折叠的工具数（供摘要文案）
 */
export function capLiveToolItems(
  live: HistoryItem[],
  maxRows: number,
): { visible: HistoryItem[]; hiddenToolCount: number } {
  // 摘要文案计工具数（非行数）——见下方 hiddenToolCount 注释。
  const totalToolCount = live.reduce((sum, it) => sum + countLiveItemTools(it), 0);

  // 预算充足：全部可见，无折叠。
  if (maxRows > 0) {
    let acc = 0;
    let cutoff = 0; // 从尾部往前，保留 [cutoff, end) 区间
    for (let i = live.length - 1; i >= 0; i--) {
      const rows = estimateLiveItemRows(live[i]);
      if (acc + rows > maxRows) {
        cutoff = i + 1;
        break;
      }
      acc += rows;
    }
    const visible = live.slice(cutoff);
    if (visible.length === live.length) {
      return { visible, hiddenToolCount: 0 };
    }
    // 摘要文案是「另有 N 个工具执行中」，故 N 必须是**工具个数**而非行数。
    // 此前误累加 estimateLiveItemRows（行数）——单工具占 1-2 行时误差不明显，但 shell
    // 实时输出让单工具最多占 ~10 行，折叠时会把「1 个工具」显示成「10 个工具」。改为
    // 累加各折叠活项的真实工具数（tool_group 计组内 tools 数，其它活项计 1）。
    const hiddenToolCount = live
      .slice(0, cutoff)
      .reduce((sum, it) => sum + countLiveItemTools(it), 0);
    return { visible, hiddenToolCount };
  }

  // maxRows <= 0（极小终端兜底）：不渲染任何活项，全部计入摘要。
  return { visible: [], hiddenToolCount: totalToolCount };
}

/** 思考摘要（从 thinking block 提取） */
export interface ThoughtSummary {
  text: string;
  /**
   * SP1：思考耗时（秒，向下取整）。来自 ThinkingBlock.durationMs，持久化后
   * 历史项重渲仍能显示「已思考 Ns」。缺省（旧数据/未测量）时 UI 回退为「思考过程」。
   */
  durationSeconds?: number;
}

/** 占位消息文本常量 */
const PLACEHOLDER_TEXT = "[系统] 自动插入占位消息以保持角色交替";

/** 判断是否为占位消息 */
export function isPlaceholderMessage(msg: Message): boolean {
  return msg.content.length === 1
    && msg.content[0].type === "text"
    && msg.content[0].text === PLACEHOLDER_TEXT;
}

/**
 * 续接标记特征串（与 SessionStore.buildResumeMarker 保持一致）。
 * 恢复会话时该 marker 作为一条 user 消息注入 ctxMgr，仅供 LLM 感知"这是续接"，
 * 不应在 TUI 里作为用户消息展示——否则用户会看到一段 <system-reminder>，
 * 甚至包含"请勿向用户提及"的自相矛盾文案。
 */
const RESUME_MARKER_SIGNATURE = "本次会话是从之前的对话恢复的续接会话";

/** 续接标记消息（恢复会话时注入,仅供 LLM,不展示） */
export function isResumeMarkerMessage(msg: Message): boolean {
  return msg.role === "user"
    && msg.content.length === 1
    && msg.content[0].type === "text"
    && msg.content[0].text.includes(RESUME_MARKER_SIGNATURE);
}

/** <task-notification> 起始标签（后台任务完成通知，由 query/loop.ts 作为 user 文本消息注入） */
const TASK_NOTIFICATION_OPEN = "<task-notification>";

/** 从单个 notification 块里提取某标签的文本内容（兼容带属性的开标签，如 <result untrusted="true">）。 */
function extractNotificationTag(block: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`);
  const m = block.match(re);
  return m ? m[1].trim() : undefined;
}

/**
 * 尝试把一条 user 消息中的「后台任务通知」块解析为专用历史项。
 *
 * 背景：后台子代理/shell 完成后，<task-notification> XML 被当作 user 文本消息注入对话。
 * 此前它走 UserMessage 全量渲染（`>` 前缀、不折叠），与同一任务的 task_output 工具结果
 * （走折叠路径）视觉割裂。这里把它识别出来，转为 task_notification 历史项（折叠展示）。
 *
 * 鲁棒性增强（对标 CC 多层防泄漏）：
 * - 不再要求消息"只含文本块"，支持 notification text block 与 tool_result 混合的场景
 *   （角色交替合并 addMessage 会把 notification 追加到含 tool_result 的消息中）
 * - 返回 { notifications, remaining } 结构：notifications 是解析出的历史项，
 *   remaining 是非 notification 的剩余 blocks（供调用侧继续走正常渲染路径）
 * - 也支持 _meta.origin === "task-notification" 标记的快速识别（中期加固路径）
 */
function tryParseTaskNotifications(msg: Message): {
  notifications: HistoryItemWithoutId[];
  remaining: import("../llm/types.ts").ContentBlock[] | null;
} | null {
  if (msg.role !== "user") return null;
  if (msg.content.length === 0) return null;

  // 快速路径：_meta 标记识别（中期加固后优先走此路径）
  if (msg._meta?.origin === "task-notification") {
    // 结构化优先：query/loop.ts 注入时把 StructuredNotification 快照放进 _meta.notif。
    // 直接读结构化字段构造历史项，**不解析 content 文本**——这样子代理结论里含
    // </result> / </task-notification> 字面量也不会破坏渲染（根治「点4」的核心）。
    //
    // 兼容单个对象与数组两种形态：query/loop 现注入数组（一条消息聚合多通知）；
    // 旧会话 resume 可能是单个对象（早期实现）。两者都遍历渲染，不丢任何一条。
    type StructuredNotif = { taskId?: string; status?: string; summary?: string; result?: string; outputFile?: string };
    const raw = msg._meta.notif as StructuredNotif | StructuredNotif[] | undefined;
    const notifList: StructuredNotif[] = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object"
        ? [raw]
        : [];
    if (notifList.length > 0) {
      return {
        notifications: notifList.map(notif => ({
          type: "task_notification" as const,
          taskId: notif.taskId ?? "",
          status: notif.status ?? "",
          summary: notif.summary ?? "",
          ...(notif.result ? { result: notif.result } : {}),
          ...(notif.outputFile ? { outputFile: notif.outputFile } : {}),
        })),
        remaining: null,
      };
    }
    // 回退正则解析：旧会话 resume（注入时还没有 _meta.notif 结构化快照）时兼容。
    // 旧数据里若结论含 XML 字面量仍可能被截断——那是历史遗留，新会话不再走此路径。
    const text = msg.content.map(b => (b.type === "text" ? b.text : "")).join("\n");
    const blocks = text.match(/<task-notification>[\s\S]*?<\/task-notification>/g);
    if (!blocks || blocks.length === 0) return null;
    const items: HistoryItemWithoutId[] = [];
    for (const block of blocks) {
      items.push(parseOneNotificationBlock(block));
    }
    return { notifications: items, remaining: null };
  }

  // 通用路径：从 content blocks 中分离 notification text blocks 与其它 blocks
  const notifTexts: string[] = [];
  const otherBlocks: import("../llm/types.ts").ContentBlock[] = [];

  for (const block of msg.content) {
    if (block.type === "text" && block.text.trimStart().startsWith(TASK_NOTIFICATION_OPEN)) {
      notifTexts.push(block.text);
    } else {
      otherBlocks.push(block);
    }
  }

  if (notifTexts.length === 0) return null;

  // 解析 notification text blocks
  const items: HistoryItemWithoutId[] = [];
  const fullText = notifTexts.join("\n");
  const xmlBlocks = fullText.match(/<task-notification>[\s\S]*?<\/task-notification>/g);
  if (!xmlBlocks || xmlBlocks.length === 0) return null;

  for (const block of xmlBlocks) {
    items.push(parseOneNotificationBlock(block));
  }

  return {
    notifications: items,
    remaining: otherBlocks.length > 0 ? otherBlocks : null,
  };
}

/** 解析单个 <task-notification> XML 块为历史项 */
function parseOneNotificationBlock(block: string): HistoryItemWithoutId {
  const taskId = extractNotificationTag(block, "task-id") ?? "";
  const status = extractNotificationTag(block, "status") ?? "";
  const summary = extractNotificationTag(block, "summary") ?? "";
  const outputFile = extractNotificationTag(block, "output-file");
  // completed 走 <result>，failed/killed 走 <error>（可能缺省，则正文为空仅显示摘要）。
  const result = extractNotificationTag(block, "result") ?? extractNotificationTag(block, "error");
  return {
    type: "task_notification",
    taskId,
    status,
    summary,
    ...(result ? { result } : {}),
    ...(outputFile ? { outputFile } : {}),
  };
}

/**
 * 内部文本块特征:这些文本是"仅供 LLM 看"的系统注入,不应作为用户消息展示。
 *
 * 背景:除续接 marker 外,主循环(query/loop.ts)与上下文管理器(context/manager.ts)
 * 还会把多类内部提示作为 user 消息**持久化进 ctxMgr**(注意:经 injectReminders 注入
 * finalMessages 的那些 reminder 是"喂给 LLM 的临时副本、不写回 ctxMgr",不会泄漏到 TUI,
 * 不在此列)。持久化进 ctxMgr 的内部文本会被 messagesToHistoryItems 渲染出来,需识别并隐藏:
 *  - `<system-reminder>` 包裹的:todo gate(buildTodoGateMessage)、空参数重试(buildEmptyParamRetryMessage) 等
 *  - `[压缩边界]` / `[已释放]`:压缩与 GC 释放的内部标记(context/manager.ts)
 * 用前缀/包含特征匹配,容忍后续文案微调。
 */
function isInternalOnlyText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<system-reminder>")
    || t.startsWith("[压缩边界]")
    || t.startsWith("[已释放]");
}

/**
 * 内部消息来源标记(写入 Message._meta.origin),用于按来源隐藏内部注入的消息对,
 * 而非依赖脆弱的文案前缀匹配。
 *
 * 单一事实源已上移到 context/internal-message.ts（INTERNAL_ORIGINS + hasInternalOrigin +
 * markInternal/buildInternalMessage 构造器 + 哨兵测试）。此处直接复用,不再本地重复定义,
 * 避免登记表在两处漂移。背景与设计见该模块头注释。
 */
function hasInternalOrigin(msg: Message): boolean {
  return hasInternalOriginImpl(msg);
}

/**
 * 整条消息是否应从展示中隐藏(占位 / 续接标记 / 纯内部文本消息)。
 * 仅当消息**只含**内部文本(无真实用户文本、无 tool_result)时才整条隐藏;
 * 混合内容(如循环恢复:orphan tool_result + 内部提示文本)交给 stripInternalTextBlocks
 * 仅剥离其中的内部文本块,保留 tool_result 的正常展示。
 */
export function isHiddenFromDisplay(msg: Message): boolean {
  if (isPlaceholderMessage(msg)) return true;
  if (isResumeMarkerMessage(msg)) return true;
  // 压缩 / 恢复注入的摘要+ack 消息对:按 _meta.origin 标记整条隐藏
  //(含 assistant ack——前缀匹配无法覆盖 assistant 侧,故用来源标记)。
  if (hasInternalOrigin(msg)) return true;
  // 仅含内部文本块(无其它类型 block)的消息整条隐藏
  return msg.content.length > 0
    && msg.content.every(b => b.type === "text" && isInternalOnlyText(b.text));
}

/**
 * 从混合内容消息中剥离"仅供 LLM"的内部文本块,保留其余 block(tool_result 等)。
 * 典型场景:循环恢复消息 = [orphan tool_result..., { text: LOOP_RECOVERY_PROMPT }],
 * tool_result 需正常展示,但 LOOP_RECOVERY_PROMPT 这段是给模型的内部提示,要隐藏。
 * 返回 content 全空时调用方应跳过该消息。
 */
function stripInternalTextBlocks(msg: Message): Message {
  if (!msg.content.some(b => b.type === "text" && isInternalOnlyText(b.text))) {
    return msg;
  }
  return {
    ...msg,
    content: msg.content.filter(b => !(b.type === "text" && isInternalOnlyText(b.text))),
  };
}

/**
 * 从消息数组中构建 tool_use_id → toolName 映射
 * 用于增量同步时传入完整的映射关系
 */
export function buildToolNameMapFromMessages(msgs: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of msgs) {
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        map.set(block.id, block.name);
      }
    }
  }
  return map;
}

/**
 * 将完整消息数组转换为 HistoryItem 序列
 *
 * 核心改进：合并 tool_use + tool_result 为单条记录
 * - assistant 消息中的 tool_use → 暂存到 pendingToolCalls
 * - user 消息中的 tool_result → 与 pending 合并，输出完整的 ToolGroup
 */
export function messagesToHistoryItems(msgs: Message[]): HistoryItemWithoutId[] {
  const toolNameMap = buildToolNameMapFromMessages(msgs);
  return messagesToHistoryItemsWithMap(msgs, toolNameMap);
}

/**
 * 带外部 toolNameMap 的转换（用于增量同步）
 */
export function messagesToHistoryItemsWithMap(
  msgs: Message[],
  toolNameMap: Map<string, string>,
): HistoryItemWithoutId[] {
  const items: HistoryItemWithoutId[] = [];
  // 暂存 assistant 消息中的 tool_use，等待 tool_result 合并
  const pendingToolCalls = new Map<string, IndividualToolCallDisplay>();

  for (const rawMsg of msgs) {
    if (isHiddenFromDisplay(rawMsg)) continue;

    // 后台任务通知（<task-notification>）：转为专用折叠历史项，
    // 不走 UserMessage 全量渲染（否则 `>` 前缀 + 不折叠，与 task_output 工具结果视觉割裂）。
    // 鲁棒性增强：支持 notification 与 tool_result 混合的场景（角色交替合并导致）。
    const notifResult = tryParseTaskNotifications(rawMsg);
    if (notifResult) {
      items.push(...notifResult.notifications);
      if (notifResult.remaining) {
        // 剩余 blocks（tool_result 等）继续走正常渲染路径
        const remainingMsg = { ...rawMsg, content: notifResult.remaining };
        const strippedRemaining = stripInternalTextBlocks(remainingMsg);
        if (strippedRemaining.content.length > 0) {
          if (strippedRemaining.role === "assistant") {
            items.push(...convertAssistantMessage(strippedRemaining, pendingToolCalls));
          } else {
            items.push(...convertUserMessage(strippedRemaining, toolNameMap, pendingToolCalls));
          }
        }
      }
      continue;
    }

    // 斜杠命令展开（inline prompt 命令，如 /commit）：这条 user 消息的正文是展开后的
    // 完整提示词，只该喂 LLM，不该作为 `> <整段提示词>` 泄漏到屏幕。渲染为「命令历史项」
    // 只显示触发命令本身（_meta.displayCommand，如 /commit），提示词内容不展示。
    if (rawMsg._meta?.origin === "command-expansion") {
      const displayCommand =
        typeof rawMsg._meta.displayCommand === "string"
          ? rawMsg._meta.displayCommand
          : "";
      if (displayCommand) {
        items.push({ type: "command", input: displayCommand, output: null });
      }
      continue;
    }

    // 混合内容消息(如循环恢复 = orphan tool_result + 内部提示文本):
    // 剥离仅供 LLM 的内部文本块,保留 tool_result 等正常 block 继续转换。
    const msg = stripInternalTextBlocks(rawMsg);
    if (msg.content.length === 0) continue;

    // 收集 tool_use 名称映射
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        toolNameMap.set(block.id, block.name);
      }
    }

    if (msg.role === "assistant") {
      items.push(...convertAssistantMessage(msg, pendingToolCalls));
    } else {
      items.push(...convertUserMessage(msg, toolNameMap, pendingToolCalls));
    }
  }

  // 如果还有未匹配的 pending tool_use（流式中断等场景），输出为 executing 状态
  if (pendingToolCalls.size > 0) {
    items.push({ type: "tool_group", tools: Array.from(pendingToolCalls.values()) });
    pendingToolCalls.clear();
  }

  return items;
}

// ── 内部转换函数 ──

function convertUserMessage(
  msg: Message,
  toolNameMap: Map<string, string>,
  pendingToolCalls: Map<string, IndividualToolCallDisplay>,
): HistoryItemWithoutId[] {
  const items: HistoryItemWithoutId[] = [];
  const textBlocks: string[] = [];
  const mergedTools: IndividualToolCallDisplay[] = [];

  for (const block of msg.content) {
    if (block.type === "text") {
      textBlocks.push(block.text);
    } else if (block.type === "tool_result") {
      const toolName = toolNameMap.get(block.tool_use_id) || "unknown";
      const isError = !!block.is_error;
      const pending = pendingToolCalls.get(block.tool_use_id);

      // 结构化 diff 优先(edit/write):有 patch 即判定为 diff,UI 直接渲染;
      // 缺失时(旧会话重放/其它工具)降级到对 content 的正则检测。
      const hasPatch = !!block.structuredPatch?.length;
      const resultDisplay: ToolResultDisplay = {
        content: block.content,
        isError,
        isDiff: hasPatch || isDiffContent(toolName, block.content),
        filename: getFilenameFromInput(toolName, pending?.input ?? {}),
        ...(hasPatch ? { structuredPatch: block.structuredPatch } : {}),
      };

      // 合并 pending tool_use + tool_result
      mergedTools.push({
        callId: block.tool_use_id,
        name: pending?.name ?? toolName,
        description: pending?.description ?? getToolSummary(toolName, {}),
        input: pending?.input ?? {},
        status: isError ? ToolCallStatus.Error : ToolCallStatus.Success,
        resultDisplay,
        resultSummary: getResultSummary(toolName, block.content, isError),
      });

      // 已合并，从 pending 中移除
      pendingToolCalls.delete(block.tool_use_id);
    }
  }

  // 文本内容 → HistoryItemUser
  // 剥离 <system-reminder>...</system-reminder> 块（@ 文件引用注入的隐藏内容），
  // 只展示用户原始输入。模型侧仍能读到完整文件内容。
  if (textBlocks.length > 0) {
    const text = textBlocks.join("\n");
    const displayText = stripSystemReminderBlocks(text);
    if (displayText) {
      items.push({ type: "user", text: displayText });
    }
  }

  // 合并后的工具结果 → HistoryItemToolGroup
  if (mergedTools.length > 0) {
    items.push({ type: "tool_group", tools: mergedTools });
  }

  return items;
}

/** 从文本中移除 <system-reminder>...</system-reminder> 块（@ 文件引用注入的隐藏内容） */
function stripSystemReminderBlocks(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

function convertAssistantMessage(
  msg: Message,
  pendingToolCalls: Map<string, IndividualToolCallDisplay>,
): HistoryItemWithoutId[] {
  const items: HistoryItemWithoutId[] = [];
  let textAccum = "";

  const flushText = () => {
    if (textAccum) {
      items.push({ type: "assistant", text: textAccum });
      textAccum = "";
    }
  };

  for (const block of msg.content) {
    if (block.type === "thinking") {
      // v2：思考块 → 独立 thinking HistoryItem（对标 Claude Code）
      flushText();
      // SP1：把持久化的 durationMs 折算为秒带入，历史项才能稳定显示耗时。
      const durationSeconds =
        typeof block.durationMs === "number"
          ? Math.floor(block.durationMs / 1000)
          : undefined;
      items.push({
        type: "thinking",
        thought: {
          text: block.thinking,
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        },
      });
    } else if (block.type === "text") {
      flushText(); // 先 flush 前面的文本（如果有的话）
      textAccum += (textAccum ? "\n" : "") + block.text;
    } else if (block.type === "tool_use") {
      flushText();
      // 暂存到 pendingToolCalls，等待 tool_result 合并
      pendingToolCalls.set(block.id, {
        callId: block.id,
        name: block.name,
        description: getToolSummary(block.name, block.input),
        input: block.input,
        status: ToolCallStatus.Executing,
      });
    }
  }

  // flush 剩余文本
  flushText();

  // 注意：不在这里输出 tool_use 的 ToolGroup
  // 它们会在 convertUserMessage 中与 tool_result 合并后输出

  return items;
}
