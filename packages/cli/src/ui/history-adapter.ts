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
import type { Message, ContentBlock } from "@sid-code/core/llm/types.ts";
import {
  getToolSummary,
  getResultSummary,
  isDiffContent,
  getFilenameFromInput,
} from "./ui-utils.ts";
// 直接复用产生端的 origin 常量,而非在此重复字符串字面量——避免"注入端打了 origin、
// 隐藏端白名单漏登记"的漂移(compact-reattach 泄漏正是此类接线遗漏)。
import { hasInternalOrigin as hasInternalOriginImpl } from "@sid-code/core/context/internal-message.ts";

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
  return [{ id: -2, type: "app_header", version } as HistoryItem, ...historyItems];
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
  return (
    msg.content.length === 1 &&
    msg.content[0].type === "text" &&
    msg.content[0].text === PLACEHOLDER_TEXT
  );
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
  return (
    msg.role === "user" &&
    msg.content.length === 1 &&
    msg.content[0].type === "text" &&
    msg.content[0].text.includes(RESUME_MARKER_SIGNATURE)
  );
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
  remaining: import("@sid-code/core/llm/types.ts").ContentBlock[] | null;
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
    type StructuredNotif = {
      taskId?: string;
      status?: string;
      summary?: string;
      result?: string;
      outputFile?: string;
      agentType?: string;
    };
    const raw = msg._meta.notif as StructuredNotif | StructuredNotif[] | undefined;
    const notifList: StructuredNotif[] = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object"
        ? [raw]
        : [];
    // 关键：remaining 必须保留**非文本** blocks（tool_result 等），不能返回 null。
    //
    // 缺陷背景（TUI 末尾残留 `⏺ task_stop` 的根因）：ctxMgr.addMessage 的角色交替**合并**
    // 会把 <task-notification> 追加进上一条同为 user 的 tool_result 消息，于是一条消息同时含
    // [tool_result(task_stop 的结果), text(通知)] 且带 _meta.origin=task-notification。
    // 此前快速路径无条件 `remaining: null`，把这条 tool_result 一并丢弃 → task_stop 的 tool_use
    // 永远配不上结果，滞留在 pendingToolCalls，最终被函数末尾的「未匹配 pending」兜底逻辑
    // 输出为 executing 态并追加到历史**末尾**，表现为任务已完成、屏幕最后却挂着一行执行中的
    // `⏺ task_stop`，误导用户以为任务还在跑。
    //
    // 修复：只吃掉通知**文本**块，其余 blocks 原样交还调用方走正常渲染路径（与通用路径一致）。
    const nonTextBlocks = msg.content.filter((b) => b.type !== "text");
    if (notifList.length > 0) {
      return {
        notifications: notifList.map((notif) => ({
          type: "task_notification" as const,
          taskId: notif.taskId ?? "",
          status: notif.status ?? "",
          summary: notif.summary ?? "",
          ...(notif.result ? { result: notif.result } : {}),
          ...(notif.outputFile ? { outputFile: notif.outputFile } : {}),
          // P1-2：agentType 只在结构化路径可得（XML 里刻意不带），用于身份色渲染。
          ...(notif.agentType ? { agentType: notif.agentType } : {}),
        })),
        remaining: nonTextBlocks.length > 0 ? nonTextBlocks : null,
      };
    }
    // 回退正则解析：旧会话 resume（注入时还没有 _meta.notif 结构化快照）时兼容。
    // 旧数据里若结论含 XML 字面量仍可能被截断——那是历史遗留，新会话不再走此路径。
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    const blocks = text.match(/<task-notification>[\s\S]*?<\/task-notification>/g);
    // 无通知块可解析时返回 null，让消息完全走正常渲染路径（tool_result 因此不会丢）。
    if (!blocks || blocks.length === 0) return null;
    const items: HistoryItemWithoutId[] = [];
    for (const block of blocks) {
      items.push(parseOneNotificationBlock(block));
    }
    return {
      notifications: items,
      remaining: nonTextBlocks.length > 0 ? nonTextBlocks : null,
    };
  }

  // 通用路径：从 content blocks 中分离 notification text blocks 与其它 blocks
  const notifTexts: string[] = [];
  const otherBlocks: import("@sid-code/core/llm/types.ts").ContentBlock[] = [];

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
  return (
    t.startsWith("<system-reminder>") || t.startsWith("[压缩边界]") || t.startsWith("[已释放]")
  );
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
 * 消息里是否含"必须渲染的工具块"——即 tool_use / tool_result。
 *
 * 这类块**不能随整条消息一起被隐藏/分流吃掉**：`tool_result` 丢了对应的 `tool_use`
 * 就永远配不上结果，滞留 pendingToolCalls，最终被兜底逻辑输出成 executing 态挂在
 * 历史**末尾**——表现为任务已完成、屏幕最后却挂着一行"执行中"的工具气泡。
 * 这是 task-notification / command-expansion / internal-origin 三处共享的隐蔽性来源：
 * 单一内容块的消息永远不暴露，只有角色交替合并把内部消息追加到含 tool_result 的
 * user 消息上时才现形。
 */
function hasToolBlocks(msg: Message): boolean {
  return msg.content.some((b) => b.type === "tool_use" || b.type === "tool_result");
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
  //
  // 但**含工具块时不整条隐藏**：否则同消息内的 tool_result 被一并丢弃(见 hasToolBlocks
  // 注释)。这条早退此前不看内容、只看 _meta.origin,违反了本函数自己的注释;
  // 现按注释办——混合内容交给调用方剥离文本块后继续渲染工具块。
  if (hasInternalOrigin(msg)) return !hasToolBlocks(msg);
  // 仅含内部文本块(无其它类型 block)的消息整条隐藏
  return (
    msg.content.length > 0 &&
    msg.content.every((b) => b.type === "text" && isInternalOnlyText(b.text))
  );
}

/**
 * 从混合内容消息中剥离"仅供 LLM"的内部文本块,保留其余 block(tool_result 等)。
 * 典型场景:循环恢复消息 = [orphan tool_result..., { text: LOOP_RECOVERY_PROMPT }],
 * tool_result 需正常展示,但 LOOP_RECOVERY_PROMPT 这段是给模型的内部提示,要隐藏。
 * 返回 content 全空时调用方应跳过该消息。
 */
function stripInternalTextBlocks(msg: Message): Message {
  if (!msg.content.some((b) => b.type === "text" && isInternalOnlyText(b.text))) {
    return msg;
  }
  return {
    ...msg,
    content: msg.content.filter((b) => !(b.type === "text" && isInternalOnlyText(b.text))),
  };
}

/**
 * 「分流但保留兄弟块」的统一出口。
 *
 * 三条整条分流/隐藏路径（task-notification 专用折叠项 / command-expansion 命令项 /
 * internal-origin 整条隐藏）都必须走这里，而不是各自 `continue`：
 * 它们吃掉的只是**文本块**（通知 XML / 展开后的提示词 / 内部 ack），同消息内的
 * `tool_use` / `tool_result` 属于兄弟块，要原样交回正常渲染路径。
 *
 * 逐处打补丁的做法已经失败过一次——task-notification 修好后另两处仍在丢块，
 * 所以这里收口成单一函数：新增任何「整条分流」路径都调它，不要再写第四份 `continue`。
 *
 * @param blocks 分流后剩余的 block（调用方已剔除自己消费掉的文本块）
 * @returns 是否产出了历史项（false = 无剩余内容，调用方直接 continue）
 */
function pushRemainingBlocks(
  rawMsg: Message,
  blocks: import("@sid-code/core/llm/types.ts").ContentBlock[],
  items: HistoryItemWithoutId[],
  toolNameMap: Map<string, string>,
  pendingToolCalls: Map<string, IndividualToolCallDisplay>,
): boolean {
  if (blocks.length === 0) return false;
  const msg = stripInternalTextBlocks({ ...rawMsg, content: blocks });
  if (msg.content.length === 0) return false;
  // 与主路径一致：先补 tool_use 名称映射，再转换（否则 tool_result 侧取不到工具名）
  for (const block of msg.content) {
    if (block.type === "tool_use") toolNameMap.set(block.id, block.name);
  }
  if (msg.role === "assistant") {
    items.push(...convertAssistantMessage(msg, pendingToolCalls));
  } else {
    items.push(...convertUserMessage(msg, toolNameMap, pendingToolCalls));
  }
  return true;
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
      // 剩余 blocks（tool_result 等）继续走正常渲染路径（与其余两条分流路径共用出口）
      if (notifResult.remaining) {
        pushRemainingBlocks(rawMsg, notifResult.remaining, items, toolNameMap, pendingToolCalls);
      }
      continue;
    }

    // 斜杠命令展开（inline prompt 命令，如 /commit）：这条 user 消息的正文是展开后的
    // 完整提示词，只该喂 LLM，不该作为 `> <整段提示词>` 泄漏到屏幕。渲染为「命令历史项」
    // 只显示触发命令本身（_meta.displayCommand，如 /commit），提示词内容不展示。
    if (rawMsg._meta?.origin === "command-expansion") {
      const displayCommand =
        typeof rawMsg._meta.displayCommand === "string" ? rawMsg._meta.displayCommand : "";
      if (displayCommand) {
        items.push({ type: "command", input: displayCommand, output: null });
      }
      // 只吃掉展开后的**提示词文本**，其余 block（tool_result 等）交回正常渲染路径。
      // 此前是无条件 continue：角色交替合并把展开消息追加进含 tool_result 的 user 消息时，
      // 那条 tool_result 被一并丢弃 → tool_use 永久 pending → 末尾挂"执行中"气泡。
      pushRemainingBlocks(
        rawMsg,
        rawMsg.content.filter((b) => b.type !== "text"),
        items,
        toolNameMap,
        pendingToolCalls,
      );
      continue;
    }

    // 内部来源消息（压缩摘要 / ack 等）含工具块时不再整条隐藏（见 isHiddenFromDisplay），
    // 但它的**文本**仍是"仅供 LLM"的，必须在这里吃掉——这类 ack 文案（如「了解，继续。」）
    // 没有 `<system-reminder>` 之类前缀，stripInternalTextBlocks 认不出来，
    // 只能按 _meta.origin 判定。
    if (hasInternalOrigin(rawMsg)) {
      pushRemainingBlocks(
        rawMsg,
        rawMsg.content.filter((b) => b.type !== "text"),
        items,
        toolNameMap,
        pendingToolCalls,
      );
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

/**
 * 把一个 tool_result 块 + 它对应的 pending tool_use 合并成**完成态**工具卡片。
 *
 * 从 convertUserMessage 内联逻辑提取为导出函数，供两个调用方共用：
 *   1. convertUserMessage —— tool_result 已入 ctxMgr 后的正常重建路径（权威路径）；
 *   2. app.ts 的 liveToolSettled 侧信道 —— 工具刚跑完、tool_result 尚未入 ctxMgr 时的
 *      即时翻卡（并行批次里先完成的工具不必等最慢的兄弟）。
 *
 * 必须共用同一份实现，否则「增量翻的卡」与「批次结束后重建的卡」会出现视觉跳变
 * （diff 判定 / 摘要文案 / 文件名任一处不一致，用户都会看到卡片内容在完成后又变一次）。
 */
export function buildCompletedToolCall(
  block: Extract<ContentBlock, { type: "tool_result" }>,
  toolName: string,
  pending?: IndividualToolCallDisplay,
  elapsedMs?: number,
): IndividualToolCallDisplay {
  const isError = !!block.is_error;

  // 结构化 diff 优先(edit/write):有 patch 即判定为 diff,UI 直接渲染;
  // 缺失时(旧会话重放/其它工具)降级到对 content 的正则检测。
  const hasPatch = !!block.structuredPatch?.length;

  // 呈现档位（执行器解析后随 block 落盘，见 llm/types.ts 的 resultDisplayMode）：
  //   - hidden  → 整条卡片不渲染，由 ToolGroupMessage 过滤（此处仍照常构造，
  //               因为「隐藏」是渲染层决定，数据层保留完整信息供 /export、轨迹回放使用）；
  //   - summary → 丢弃 ⎿ 正文（content 置空），header 摘要承担说明职责。
  // 错误结果不受管辖：执行器不会给错误 block 打这个标记，此处再守一道，
  // 防御未来有人手工构造 block（错误必须可见，见 tool/types.ts 硬约束 ②）。
  const displayMode = isError ? undefined : block.resultDisplayMode;
  const suppressBody = displayMode === "summary" || displayMode === "hidden";

  const resultDisplay: ToolResultDisplay = {
    // summary/hidden 档把正文置空：那份 content 是给模型读的提示词，不是给用户看的。
    // 保留 isError/filename 等元信息不变——只吃正文，不动语义。
    content: suppressBody ? "" : block.content,
    isError,
    // isDiff 判定喂原始 content：置空后再判会恒为 false，但 summary 档的工具本就不产 diff，
    // 这里保持用原文判定是为了「档位与 diff 判定解耦」——将来若有产 diff 的 summary 工具，
    // 不会因为顺序耦合出一个隐性 bug。
    isDiff: hasPatch || isDiffContent(toolName, block.content),
    filename: getFilenameFromInput(toolName, pending?.input ?? {}),
    ...(hasPatch ? { structuredPatch: block.structuredPatch } : {}),
    ...(displayMode ? { displayMode } : {}),
  };

  return {
    callId: block.tool_use_id,
    name: pending?.name ?? toolName,
    // 摘要：优先用 pending 上算好的，**空串也要重算**（故用 `||` 而非 `??`）。
    //
    // 此前是 `pending?.description ?? getToolSummary(toolName, {})`，两处都不对：
    //   1. `??` 只兜 null/undefined——pending 里存着空串（工具此前没有摘要分支时的产物）
    //      会被原样沿用，重算的机会被跳过；
    //   2. 兜底喂的是**空对象**，任何工具都只能返回 ""。真正可用的 input 就在 `pending.input`
    //      里（下一行正在用它），拿它重算才有意义。
    // pending 整个缺失时确实无 input 可依（那是流式中断的残缺数据），此时退回 "" 是正确的
    // ——没有输入就编不出摘要，这一路只能靠工具名本身。
    description: pending?.description || getToolSummary(toolName, pending?.input ?? {}),
    input: pending?.input ?? {},
    status: isError ? ToolCallStatus.Error : ToolCallStatus.Success,
    resultDisplay,
    // 结果摘要：summary/hidden 档不给。
    //
    // 兜底摘要是 `${content.length} 字符`，而这两档的 content 是**给模型读的提示词**
    // ——量它的长度会产出彻头彻尾的假指标（实测 todo_write 会报"258 字符"，
    // 描述的是前向推进指令本身，与任务进度毫无关系）。同 think/lsp 已修过的同型坑。
    //
    // 判据用 `displayMode` 而不是工具名白名单：`skill` 按 mode 分档（activate=summary、
    // delegate=原样展示），只有工具自己在执行现场才知道本次是哪一档。白名单在这里
    // 既表达不了 skill，又会与工具侧自报形成第二个事实源、早晚漂移。
    //
    // 注意必须喂 `displayMode` 判定、不能改喂置空后的 `resultDisplay.content`：
    // 本函数拿到的 `block.content` 始终是**原始完整正文**（置空只发生在 resultDisplay 里），
    // 所以"content 为空所以自然算出 0 字符"是不成立的——那正是这里必须显式分流的原因。
    resultSummary: suppressBody ? "" : getResultSummary(toolName, block.content, isError),
    // 真实耗时：增量路径由执行器透传；重建路径（tool_result 已入历史）没有这个信息，
    // 沿用 pending 上已有的值（若有），保证卡片完成后耗时不会凭空消失。
    ...(elapsedMs !== undefined
      ? { elapsedMs }
      : pending?.elapsedMs !== undefined
        ? { elapsedMs: pending.elapsedMs }
        : {}),
  };
}

/**
 * 侧信道翻卡的判定与构造（增量呈现的**语义单点**）。
 *
 * 语义：给定一个仍在执行中的工具卡片与侧信道里的已完成结果，返回翻好的完成态卡片；
 * 不该翻时返回 null（调用方保持原卡片引用不动）。
 *
 * 不该翻的两种情况，都必须留在这里、不许调用方各自判断：
 *   1. 侧信道里没有这个 callId —— 该工具还没跑完；
 *   2. 侧信道条目不是 tool_result —— 防御性：非结果块不能当完成态渲染。
 *
 * 为什么要把这三行提成函数：app.ts 有**两个**调用点（全量重建的 injectLiveToolSettled
 * 与轻量重渲的 refreshLiveProgressInPlace），两处必须逐字同判定。此前两处各写一遍
 * `if (!settled || settled.block.type !== "tool_result") continue;`，改一处漏一处就会
 * 出现「全量重建翻了、轻量路径没翻」这类只在特定时序下复现的漂移。收成单点后，
 * 判定漂移在类型层面就不可能发生。
 *
 * 调用方仍需自己守 `status === Executing`：那是「要不要考虑翻」的前置门（已完成卡片
 * 由权威路径渲染，不许被侧信道二次覆盖），与「能不能翻」是两件事。
 */
export function buildSettledToolCallIfReady(
  tool: IndividualToolCallDisplay,
  settled: { block: ContentBlock; elapsedMs?: number } | undefined,
): IndividualToolCallDisplay | null {
  if (!settled) return null;
  if (settled.block.type !== "tool_result") return null;
  return buildCompletedToolCall(settled.block, tool.name, tool, settled.elapsedMs);
}

/**
 * 把侧信道里已完成的工具结果注入 historyItems，把仍是 executing 的卡片就地翻成完成态。
 *
 * **就地修改**传入的 historyItems（这些 item 是 assignIds 刚 new 出来的，非共享引用，
 * 改它不影响 Static 已缓存的已完成项）。返回翻掉的卡片数，供调用方判断有无变化。
 *
 * 只改 `status === Executing` 的项：tool_result 已入 ctxMgr 的项本就是完成态（由权威
 * 路径渲染），不需要也不应该被侧信道二次覆盖。
 *
 * 从 app.ts 的闭包里提出来，只为一件事：**让它可被测试**。原先这段逻辑写在
 * setupTUICallbacks 的闭包内，外部拿不到引用，测试只能"照抄一遍逻辑"——那种测试在
 * 生产代码漂移时照样绿，等于没测。
 */
export function injectSettledToolCalls(
  historyItems: HistoryItem[],
  settledById: Map<string, { block: ContentBlock; elapsedMs?: number }>,
): number {
  if (settledById.size === 0) return 0;
  let flipped = 0;
  for (const item of historyItems) {
    if (item.type !== "tool_group") continue;
    for (let i = 0; i < item.tools.length; i++) {
      const tool = item.tools[i];
      if (tool.status !== ToolCallStatus.Executing) continue;
      const next = buildSettledToolCallIfReady(tool, settledById.get(tool.callId));
      if (!next) continue;
      item.tools[i] = next;
      flipped++;
    }
  }
  return flipped;
}

/**
 * 把子代理进度快照注入 historyItems 里仍在执行的 `sub_agent` 工具卡片。
 *
 * **就地修改**传入的 historyItems（与 injectSettledToolCalls 同一约定：这些 item 是
 * assignIds 刚 new 出来的，非共享引用）。返回注入条数，供调用方判断有无变化。
 *
 * 只改 `status === Executing` 的项。已完成的 `sub_agent` 卡片不注入——它的位置该让给
 * 真实结果（`<subagent-result>`），继续挂着"7 工具 · 12.4k token"就是把进行中的语言
 * 贴到已完成的东西上。
 *
 * 与 injectSettledToolCalls 一样从 app.ts 闭包里提出来，只为**可被测试**：写在
 * setupTUICallbacks 闭包内的逻辑，测试只能照抄一遍，生产代码漂移时照样绿。
 */
export function injectAgentProgress(
  historyItems: HistoryItem[],
  progressById: Map<
    string,
    {
      recentActivities: string[];
      agentType: string;
      toolUseCount: number;
      tokenCount: number;
      elapsedMs?: number;
    }
  >,
): number {
  if (progressById.size === 0) return 0;
  let injected = 0;
  for (const item of historyItems) {
    if (item.type !== "tool_group") continue;
    for (const tool of item.tools) {
      if (tool.status !== ToolCallStatus.Executing) continue;
      const progress = progressById.get(tool.callId);
      if (!progress) continue;
      tool.agentProgress = progress;
      injected++;
    }
  }
  return injected;
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
      const pending = pendingToolCalls.get(block.tool_use_id);

      mergedTools.push(buildCompletedToolCall(block, toolName, pending));

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
        typeof block.durationMs === "number" ? Math.floor(block.durationMs / 1000) : undefined;
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
