/**
 * 消息历史不变量 — 单一事实源
 *
 * 背景（ADR-039 + 系统级查漏补缺方案 D1-4）：
 * OpenAI 兼容协议要求带 tool_calls 的 assistant 消息后，必须紧跟对**每一个**
 * tool_call_id 的 tool 响应消息，缺一即 400
 * （"An assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'"）。
 *
 * ADR-039 在**生产端单点**（executeTools 出口）守住了"N 个 tool_use → N 个 tool_result"。
 * 但"消息历史完整性"是一个**全局不变量**：孤儿 tool_use 仍可能从 executeTools
 * 之外的路径（中断时序、followup 排序、plan-mode 转换）进入 ctxMgr 消息历史。
 *
 * 本模块把"无孤儿 tool_use"抽成**纯函数**，作为单一事实源，供：
 *   - D1-1 convertMessages 发送前关卡（消费端只读校验 + 告警）
 *   - D1-2 中断路径完整性测试
 *   - D1-3 followup / plan-mode 时序不变量测试
 *   - 未来所有 OpenAI 兼容 provider 复用
 *
 * 纯函数：无副作用、无 I/O、无日志。调用方负责"发现后怎么办"（告警 / 落盘 / 抛错）。
 */

import type { ContentBlock, Message, ToolResultBlock } from "../llm/types.ts";

/** 一条孤儿 tool_use 记录（assistant 里有 tool_use，但后续无对应 tool_result） */
export interface OrphanToolUse {
  /** 孤儿 tool_use 的 id（即缺失对应 tool_result 的 tool_call_id） */
  id: string;
  /** 工具名（诊断用） */
  name: string;
  /** 该 tool_use 所在的 assistant 消息在 messages 数组中的下标 */
  messageIndex: number;
}

/** 一条"游离 tool_result"记录（tool_result 找不到任何在它之前出现的 tool_use） */
export interface DanglingToolResult {
  /** tool_result 指向的 tool_use_id */
  toolUseId: string;
  /** 该 tool_result 所在消息在 messages 数组中的下标 */
  messageIndex: number;
}

/** 消息历史完整性检查结果 */
export interface MessageHistoryIntegrity {
  /** 是否完整（无孤儿 tool_use 且无游离 tool_result） */
  intact: boolean;
  /** 孤儿 tool_use 列表（缺对应 tool_result）——这是 OpenAI 400 的直接成因 */
  orphans: OrphanToolUse[];
  /** 游离 tool_result 列表（tool_result 无前置 tool_use）——同样违反协议 */
  dangling: DanglingToolResult[];
}

/**
 * 从单条消息的 content 中提取所有 tool_use block。
 * 容忍 content 不是数组（纯文本消息在内部已规范为数组，但防御性处理）。
 */
function extractToolUses(content: ContentBlock[]): Extract<ContentBlock, { type: "tool_use" }>[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
  );
}

/**
 * 从单条消息的 content 中提取所有 tool_result block。
 */
function extractToolResults(
  content: ContentBlock[],
): Extract<ContentBlock, { type: "tool_result" }>[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
  );
}

/**
 * 核心：检查消息历史完整性。
 *
 * 算法（一次顺序扫描）：
 *   - 收集所有 assistant.tool_use 的 id（记录出现位置）
 *   - 收集所有 user.tool_result 的 tool_use_id
 *   - 孤儿 = 出现在 tool_use 集合但不在 tool_result 集合
 *   - 游离 = 出现在 tool_result 集合但不在 tool_use 集合
 *
 * 注意：本函数只校验"集合配对",不校验"严格相邻顺序"。OpenAI 实际还要求
 * tool 消息紧跟 assistant.tool_calls，但 sid-code 的 convertMessages 会把
 * 同一 user 消息的 tool_result 拆成独立 role:"tool" 消息插在对应位置，
 * 顺序由 addMessage 时序保证（见 ADR-019）。这里聚焦"缺失/多余"这个 400 的主因。
 *
 * 纯函数：不修改入参，不产生副作用。
 */
export function checkMessageHistoryIntegrity(messages: Message[]): MessageHistoryIntegrity {
  // tool_use id → { name, messageIndex }（保留首次出现位置）
  const toolUseMap = new Map<string, { name: string; messageIndex: number }>();
  // tool_result 指向的 id → messageIndex（保留首次出现位置）
  const toolResultMap = new Map<string, number>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || !Array.isArray(msg.content)) continue;

    if (msg.role === "assistant") {
      for (const tu of extractToolUses(msg.content)) {
        if (!toolUseMap.has(tu.id)) {
          toolUseMap.set(tu.id, { name: tu.name, messageIndex: i });
        }
      }
    } else if (msg.role === "user") {
      for (const tr of extractToolResults(msg.content)) {
        if (!toolResultMap.has(tr.tool_use_id)) {
          toolResultMap.set(tr.tool_use_id, i);
        }
      }
    }
  }

  const orphans: OrphanToolUse[] = [];
  for (const [id, info] of toolUseMap) {
    if (!toolResultMap.has(id)) {
      orphans.push({ id, name: info.name, messageIndex: info.messageIndex });
    }
  }

  const dangling: DanglingToolResult[] = [];
  for (const [toolUseId, messageIndex] of toolResultMap) {
    if (!toolUseMap.has(toolUseId)) {
      dangling.push({ toolUseId, messageIndex });
    }
  }

  // 按 messageIndex 排序，让诊断输出稳定可读
  orphans.sort((a, b) => a.messageIndex - b.messageIndex);
  dangling.sort((a, b) => a.messageIndex - b.messageIndex);

  return {
    intact: orphans.length === 0 && dangling.length === 0,
    orphans,
    dangling,
  };
}

/**
 * 便捷判定：消息历史是否存在孤儿 tool_use（最常用的子判定）。
 */
export function hasOrphanToolUse(messages: Message[]): boolean {
  return checkMessageHistoryIntegrity(messages).orphans.length > 0;
}

/**
 * 生成人类可读的违例摘要（用于 log.error / 落盘诊断）。
 * 不含完整消息内容，只含 id / name / 位置，避免泄露与膨胀。
 */
export function describeIntegrityViolation(result: MessageHistoryIntegrity): string {
  if (result.intact) return "消息历史完整（无孤儿 tool_use / 无游离 tool_result）";
  const parts: string[] = [];
  if (result.orphans.length > 0) {
    const items = result.orphans
      .map(o => `${o.name}(id=${o.id} @msg#${o.messageIndex})`)
      .join(", ");
    parts.push(`${result.orphans.length} 个孤儿 tool_use: ${items}`);
  }
  if (result.dangling.length > 0) {
    const items = result.dangling
      .map(d => `tool_use_id=${d.toolUseId} @msg#${d.messageIndex}`)
      .join(", ");
    parts.push(`${result.dangling.length} 个游离 tool_result: ${items}`);
  }
  return parts.join("; ");
}

/**
 * 断言消息历史完整，否则抛错（供 strict 模式 / 测试使用）。
 *
 * @param messages 待校验的消息历史
 * @param context  诊断上下文标签（如 provider 名 / 调用点），拼进错误信息
 * @throws Error 当存在孤儿 tool_use 或游离 tool_result 时
 */
export function assertMessageHistoryIntact(messages: Message[], context = ""): void {
  const result = checkMessageHistoryIntegrity(messages);
  if (!result.intact) {
    const prefix = context ? `[${context}] ` : "";
    throw new MessageHistoryViolationError(
      `${prefix}消息历史违反 tool_use/tool_result 协议不变量: ${describeIntegrityViolation(result)}`,
      result,
    );
  }
}

/** backfill 占位 tool_result 的默认文案（统一事实源，便于测试断言 & 诊断检索） */
export const ORPHAN_BACKFILL_CONTENT =
  "[系统] 此工具调用未被执行（被循环检测/中断/时序切断），自动补占位结果以维持 tool_use/tool_result 协议配对。";

/** backfill 结果 */
export interface BackfillResult {
  /** 是否发生了修补（false 表示历史本就完整，messages 原样返回引用不变） */
  changed: boolean;
  /** 修补后的消息历史（changed=false 时为入参同一引用；changed=true 时为新数组） */
  messages: Message[];
  /** 本次补齐的孤儿明细（供日志/落盘/测试） */
  backfilled: OrphanToolUse[];
  /** 本次切除的游离 tool_result 明细（供日志/落盘/测试） */
  stripped: DanglingToolResult[];
}

/**
 * 生产端协议兜底：使消息历史满足 tool_use/tool_result 配对，让 OpenAI 400 无法发生。
 *
 * 两类破缺各有正解（顺序执行，互不干扰）：
 *   1. **游离 tool_result**（tool_result 找不到前置 tool_use，多由 slice/snip 切断配对产生）：
 *      被切掉的 tool_use 已永久丢失语义，补占位无意义 → **直接切除**该 tool_result block；
 *      消息因此变空则整条删除。
 *   2. **孤儿 tool_use**（assistant 有 tool_use 但后续无 tool_result，多由中断/循环切断产生）：
 *      为其补 error 占位 tool_result（紧跟对应 assistant 之后，或合并进紧邻的已有 user 消息）。
 *
 * 设计（对齐 ADR-039「不变量在出口强制」）：
 *   - 这是**生产端**修补（在 ctxMgr 历史层），不是 ADR-039 否决的「convertMessages 消费端修数据」。
 *     ADR-039 方案 B 否决的是「在 provider 转换时悄悄改数据掩盖问题」；本函数在更上游的
 *     消息历史层显式补齐/切除 + 由调用方告警落盘，是「让脏数据无法形成」而非「掩盖」。
 *   - 先切游离、后补孤儿：切除会改变消息下标，故孤儿的占位插入基于**切除后**的数组重新计算，
 *     避免下标漂移导致占位插错位置。
 *
 * 纯函数：不修改入参数组（changed 时返回新数组），无 I/O、无日志。
 *
 * @param messages 待修补的消息历史
 * @returns BackfillResult；历史本就完整时 changed=false 且原样返回入参引用
 */
export function backfillOrphanToolResults(messages: Message[]): BackfillResult {
  const initial = checkMessageHistoryIntegrity(messages);
  if (initial.orphans.length === 0 && initial.dangling.length === 0) {
    return { changed: false, messages, backfilled: [], stripped: [] };
  }

  // ─── 第一阶段：切除游离 tool_result ───
  // 游离无对应 tool_use，无法补齐，只能剥离。被剥空的消息整条删除（避免空 content user 消息）。
  const stripped = initial.dangling;
  let working: Message[] = messages;
  if (stripped.length > 0) {
    // 按消息下标聚合该消息内需要剥离的游离 tool_use_id（游离可能在任意位置，非只在 [0]）
    const danglingIdsByMsgIdx = new Map<number, Set<string>>();
    for (const d of stripped) {
      const set = danglingIdsByMsgIdx.get(d.messageIndex);
      if (set) set.add(d.toolUseId);
      else danglingIdsByMsgIdx.set(d.messageIndex, new Set([d.toolUseId]));
    }

    const afterStrip: Message[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const danglingIds = danglingIdsByMsgIdx.get(i);
      if (!danglingIds || !Array.isArray(msg.content)) {
        afterStrip.push(msg);
        continue;
      }
      // 剥离该消息内所有游离 tool_result block
      const kept = msg.content.filter(
        b => !(b.type === "tool_result" && danglingIds.has(b.tool_use_id)),
      );
      if (kept.length === 0) continue; // 整条删除（content 被剥空）
      afterStrip.push({ ...msg, content: kept });
    }
    working = afterStrip;
  }

  // ─── 第二阶段：在切除后的数组上补孤儿占位 ───
  // 必须基于 working 重新计算孤儿下标（切除游离改变了消息下标，沿用 initial.orphans 会插错位）。
  const afterStripIntegrity = checkMessageHistoryIntegrity(working);
  const orphans = afterStripIntegrity.orphans;
  if (orphans.length === 0) {
    // 仅有游离、无孤儿：切除即完成
    return { changed: true, messages: working, backfilled: [], stripped };
  }

  // 按 assistant 消息下标聚合缺失的占位 tool_result
  const placeholdersByMsgIdx = new Map<number, ToolResultBlock[]>();
  for (const orphan of orphans) {
    const block: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: orphan.id,
      content: ORPHAN_BACKFILL_CONTENT,
      is_error: true,
    };
    const arr = placeholdersByMsgIdx.get(orphan.messageIndex);
    if (arr) arr.push(block);
    else placeholdersByMsgIdx.set(orphan.messageIndex, [block]);
  }

  const out: Message[] = [];
  for (let i = 0; i < working.length; i++) {
    out.push(working[i]);
    const placeholders = placeholdersByMsgIdx.get(i);
    if (!placeholders) continue;

    // 若紧邻的下一条是 user 消息，把占位合并进去（避免 user/user 不交替）
    const next = working[i + 1];
    if (next && next.role === "user" && Array.isArray(next.content)) {
      out.push({ ...next, content: [...placeholders, ...next.content] });
      i++; // 已消费 next
    } else {
      // 否则插入一条新的 user 消息承载占位
      out.push({ role: "user", content: placeholders });
    }
  }

  return { changed: true, messages: out, backfilled: orphans, stripped };
}

/**
 * 安全尾部切片：取尾部约 N 条消息，但保证切片起点不会落在"游离 tool_result"上。
 *
 * 背景（Session 0427d1bd 400 根因）：restoreSession 用 `slice(-N)` 固定数量截断，
 * 可能切断 tool_use/tool_result 配对——若被切掉的 assistant.tool_use 的 tool_result
 * 恰好落在切片起点，就形成游离 tool_result，转成 role:"tool" 后无前置 tool_calls → 400。
 *
 * 算法（向前收缩到干净边界）：
 *   1. 取 messages.slice(-n) 作为初始窗口。
 *   2. 检查窗口内是否有游离 tool_result（其 tool_use 不在窗口内）。
 *   3. 有则向前扩展窗口（多纳入更早的消息，最多扩展 maxExpand 条）尝试把对应 tool_use 纳入。
 *   4. 扩展耗尽仍有游离，则从窗口头部逐条收缩（丢弃头部消息），直到窗口起点干净。
 *
 * 注意：本函数只消除"游离 tool_result"（400 主因）。若收缩后窗口起点是 assistant 孤儿
 * tool_use（缺 tool_result），交由发送前 backfillOrphanToolResults 补占位即可，无需在此处理。
 *
 * 纯函数：不修改入参，返回新数组（或入参的 slice 视图）。
 *
 * @param messages 完整消息历史
 * @param n        期望保留的尾部消息数
 * @param maxExpand 向前扩展的最大消息数（默认 5，与 findCompressSplitPoint 的尾部裕量一致）
 */
export function safeSliceTail(messages: Message[], n: number, maxExpand = 5): Message[] {
  if (messages.length <= n) return messages.slice();

  // 起点候选：先尝试 slice(-n)，必要时向前扩展
  let start = messages.length - n;
  const minStart = Math.max(0, start - maxExpand);

  // 向前扩展：只要窗口内存在游离 tool_result 且还能再纳入更早消息，就左移起点
  while (start > minStart) {
    const window = messages.slice(start);
    if (checkMessageHistoryIntegrity(window).dangling.length === 0) break;
    start--;
  }

  // 扩展耗尽仍有游离 → 从头部收缩，丢弃头部消息直到起点干净
  while (start < messages.length) {
    const window = messages.slice(start);
    if (checkMessageHistoryIntegrity(window).dangling.length === 0) break;
    start++;
  }

  return messages.slice(start);
}

/**
 * 协议不变量违例专用错误类型。
 * 携带结构化 detail，便于 D3-2 专项落盘提取配对明细。
 */
export class MessageHistoryViolationError extends Error {
  readonly detail: MessageHistoryIntegrity;
  constructor(message: string, detail: MessageHistoryIntegrity) {
    super(message);
    this.name = "MessageHistoryViolationError";
    this.detail = detail;
  }
}
