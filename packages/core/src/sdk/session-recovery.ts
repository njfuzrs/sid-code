/**
 * 会话中断检测与恢复
 *
 * 从持久化的消息历史恢复会话时，跑一条脏数据清洗管道（P0-2），再检测上一次运行
 * 是否在中途被中断（P1-5）：
 *
 * 清洗管道（依次执行，每层只做一件事，方便排查恢复问题时定位是哪层丢的数据）：
 *   1. migrateLegacyFormats          —— 格式迁移预留点（兼容旧版本消息结构）
 *   2. stripInvalidPermissionModes   —— 清理引用了已下线权限模式的 _meta 字段
 *   3. filterUnresolvedToolUses      —— 过滤有 tool_use 但**其后**无对应 tool_result 的调用（顺序敏感配对）
 *   4. filterOrphanedThinkingOnlyMessages —— 过滤流式中断残留的纯 thinking assistant 消息
 *   5. filterWhitespaceOnlyAssistantMessages —— 过滤内容被清空后的空白 assistant 消息
 *   6. validateContentBlockIntegrity —— 剔除缺失关键字段（id/name/tool_use_id）的不完整 block
 *                                       （只剔 block，不丢整条消息；剥空的消息才整条删）
 *   7. stripDanglingToolResultsFilter —— 切除游离 tool_result（有结果无调用；第 3 层的反方向）
 *
 * 中断检测三态（对齐 CC 的 none / interrupted_prompt / interrupted_turn）：
 *   - none              正常结束：最后一条是 assistant 消息
 *   - interrupted_prompt 用户输入了但 Agent 还没开始回复（末尾是纯文本 user 消息）
 *   - interrupted_turn   Agent 执行完工具但还没来得及回复就被中断（末尾是 tool_result）
 *
 * 对齐 Claude Code deserializeMessagesWithInterruptDetection（spec §5.4）。
 */

import type { ContentBlock, Message } from "../llm/types.ts";
import { isReasoningOnlyBlock } from "../llm/types.ts";
import { getLogger } from "../debug/logger.ts";
import { stripDanglingToolResults } from "../agent/message-invariants.ts";
import { PERMISSION_MODE_VALUES } from "../permission/mode.ts";

/** 中断状态 */
export type TurnInterruptionState =
  | { kind: "none" }
  | { kind: "interrupted_prompt"; message: Message }
  | { kind: "interrupted_turn"; lastToolNames: string[] };

/** 反序列化结果 */
export interface DeserializeResult {
  messages: Message[];
  turnInterruptionState: TurnInterruptionState;
}

// 缺陷 14：这里曾有一个「终结性工具白名单」TERMINAL_TOOL_NAMES（对标 CC 的 Brief/SendUserFile），
// 恒为空集，它守护的 none 分支在生产上不可达，只有单测往里 add 过。sid-code 的主循环在工具结果
// 之后总会再请求一次模型，不存在「调用完就合法结束」的工具。哪天真有了，在中断检测里按工具定义
// 的属性判，不要再放一个可被任何人 add 的全局可变 Set。

/** 有效的权限模式集合（P0-2 第 2 层用）。直接取 permission/mode.ts 的枚举，不手抄（缺陷 13）；
 *  历史消息 _meta.permissionMode 若引用了不在此列表中的值，视为已下线，清理之。 */
const VALID_PERMISSION_MODES: ReadonlySet<string> = new Set(PERMISSION_MODE_VALUES);

interface FilterContext {
  log: (reason: string, detail: string) => void;
}

type MessageFilter = (messages: Message[], ctx: FilterContext) => Message[];

/** 第 1 层：格式迁移。当前消息格式稳定未变更，预留迁移点——
 *  未来若 _meta.origin 等枚举值调整，在此把旧值重写为新值，而不是让恢复直接失败。 */
const migrateLegacyFormats: MessageFilter = (messages) => messages;

/** 第 2 层：权限模式清洗——历史消息里引用的权限模式若已从系统中下线，清理该字段
 *  （不丢弃整条消息，只清理失效的 _meta 子字段，避免恢复后权限系统按无效值报错）。 */
const stripInvalidPermissionModes: MessageFilter = (messages, ctx) => {
  return messages.map((msg) => {
    const meta = msg._meta as { permissionMode?: string } | undefined;
    const mode = meta?.permissionMode;
    if (mode && !VALID_PERMISSION_MODES.has(mode)) {
      ctx.log("权限模式清洗", `丢弃已失效的 permissionMode="${mode}"`);
      const { permissionMode: _drop, ...restMeta } = meta;
      return { ...msg, _meta: restMeta };
    }
    return msg;
  });
};

/** 第 3 层：过滤未解析的 tool_use（有 tool_use 但无对应 tool_result）—— 否则 API 报错。
 *
 *  必须顺序敏感（缺陷 16）：API 的判据是「这个 tool_use **之后**必须出现对应的 tool_result」，
 *  而不是「这个 id 在整段历史里随便哪儿有结果」。早先这里先把全历史的 tool_result id 收进一个
 *  Set 再判定，判据退化成集合成员关系，会带来两类漏过滤：
 *    1. tool_result 排在 tool_use 之前（历史被截断/重排/拼接出的脏数据）——集合判据认为
 *       「已解析」而保留，API 却按顺序判 400；
 *    2. 跨轮同 id 复用（--resume 与 compaction 重建出的历史拼接，见
 *       resume-vs-process-session-id-two-different-values）——前面那轮的 result 会把后面
 *       那轮尚缺结果的 tool_use 一并「洗白」，缺少结果的那次调用漏过滤后照样 400。
 *  所以改成一次前向扫描按出现顺序配对：tool_use 入队，遇到 tool_result 就与队中最早的同 id
 *  tool_use 配对（FIFO：一个 result 消费一次 use，所以同 id 出现 N 次就要 N 个 result 才算全解析），
 *  扫描结束仍在队列里的才是未解析。配对之后才出现的 result（use 之前无队列项）不回溯认领，
 *  视为游离，交给第 7 层切除。 */
const filterUnresolvedToolUses: MessageFilter = (messages, ctx) => {
  // 已出现、尚未配对的 tool_use：记录位置以便回填剔除结果；队列保持出现顺序
  const pending = new Map<string, Array<{ messageIndex: number; contentIndex: number }>>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || !Array.isArray(msg.content)) continue;
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];
      if (block.type === "tool_use") {
        const queue = pending.get(block.id);
        const entry = { messageIndex: i, contentIndex: j };
        if (queue) queue.push(entry);
        else pending.set(block.id, [entry]);
      } else if (block.type === "tool_result") {
        const queue = pending.get(block.tool_use_id);
        if (queue && queue.length > 0) {
          queue.shift();
          if (queue.length === 0) pending.delete(block.tool_use_id);
        }
        // 队列里没有可配对的 use（result 出现在 use 之前 / use 已被更早的 result 消费完）
        // → 忽略。这里不删 result：本层职责只是判 unpaired use，游离结果归第 7 层统一切除。
      }
    }
  }

  if (pending.size === 0) return messages;

  // 未配对的 tool_use 按所在消息聚合，逐块剔除
  const dropByMessage = new Map<number, Set<number>>();
  for (const [id, queue] of pending) {
    for (const { messageIndex, contentIndex } of queue) {
      const name = (messages[messageIndex].content[contentIndex] as { name: string }).name;
      ctx.log("未解析tool_use过滤", `丢弃 tool_use id=${id} name=${name}`);
      let set = dropByMessage.get(messageIndex);
      if (!set) {
        set = new Set();
        dropByMessage.set(messageIndex, set);
      }
      set.add(contentIndex);
    }
  }

  return messages.map((msg, i) => {
    const drop = dropByMessage.get(i);
    // 只剔 block、不删消息：整条被剔空时返回 content 为空的 assistant，由第 5 层统一丢弃，
    // 保持各层「只做一件事」的分工，也让日志能指出是哪个 id 没配上。
    if (!drop) return msg;
    return { ...msg, content: msg.content.filter((_, idx) => !drop.has(idx)) };
  });
};

/** 第 4 层：孤立 thinking-only 消息过滤——流式中断可能残留只有 thinking/redacted_thinking
 *  block 的 assistant 消息（模型还没来得及产出正文就被打断），这类消息对续接无意义，
 *  且部分 provider 会拒绝只含 thinking 块的消息。 */
const filterOrphanedThinkingOnlyMessages: MessageFilter = (messages, ctx) => {
  return messages.filter((msg) => {
    if (msg.role !== "assistant" || msg.content.length === 0) return true;
    const hasNonThinking = msg.content.some((b) => !isReasoningOnlyBlock(b));
    if (!hasNonThinking) {
      ctx.log(
        "孤立thinking消息过滤",
        "丢弃仅含 thinking/redacted_thinking block 的 assistant 消息",
      );
      return false;
    }
    return true;
  });
};

/** 第 5 层：过滤空白 assistant 消息（content 被上层过滤清空后留下的空壳） */
const filterWhitespaceOnlyAssistantMessages: MessageFilter = (messages, ctx) => {
  return messages.filter((msg) => {
    if (msg.role !== "assistant") return true;
    if (msg.content.length === 0) {
      ctx.log("空白助手消息过滤", "丢弃 content 为空的 assistant 消息");
      return false;
    }
    return true;
  });
};

/** 第 6 层：content block 完整性校验——流式中断可能产生缺失关键字段的不完整 block，
 *  这类 block 发给 API 必定 400，不如恢复阶段就主动剔除。
 *
 *  只剔坏 block，不丢整条消息（缺陷 12）。以前一个坏 tool_use 就丢掉整条 assistant，连带同条里
 *  好的 tool_use；它们的 tool_result 留在下一条 user 里成了游离结果，最后由第 7 层切掉——
 *  历史没 400，但好工具的调用与结果一起凭空消失，末尾的说明文字也跟着丢。
 *  剔完被剥空的消息整条删，坏 tool_use 留下的游离 tool_result 仍交第 7 层切除。 */
const validateContentBlockIntegrity: MessageFilter = (messages, ctx) => {
  const out: Message[] = [];
  for (const msg of messages) {
    const content = msg.content.filter((block) => {
      if (block.type === "tool_use" && (!block.id || !block.name)) {
        ctx.log("contentBlock完整性校验", `丢弃缺失 id/name 的 tool_use block id=${block.id}`);
        return false;
      }
      if (block.type === "tool_result" && !block.tool_use_id) {
        ctx.log("contentBlock完整性校验", "丢弃缺失 tool_use_id 的 tool_result block");
        return false;
      }
      return true;
    });
    if (content.length === msg.content.length) out.push(msg);
    else if (content.length > 0) out.push({ ...msg, content });
    else ctx.log("contentBlock完整性校验", `${msg.role} 消息剔除后为空，整条丢弃`);
  }
  return out;
};

/** 第 7 层：切除游离 tool_result（N11）——第 3 层的反方向。
 *  assistant_message 与作为 user_message 落盘的工具结果写入时机不同，崩溃窗口里丢了
 *  assistant 那条，剩下的就是找不到 tool_use 的 tool_result。以前这里放行、靠发送期
 *  finalizeMessagesForSend 兜底切掉：首屏先渲染出来、第一次发送才消失，日志还归到
 *  「发送前游离切除」，排查会往发送逻辑找。判据与切除直接复用 message-invariants
 *  的权威实现，不另写一套。放最后：前 6 层删消息可能制造新的游离，须在它们之后判。 */
const stripDanglingToolResultsFilter: MessageFilter = (messages, ctx) => {
  const { messages: out, stripped } = stripDanglingToolResults(messages);
  for (const d of stripped) {
    ctx.log("游离tool_result切除", `丢弃 tool_result tool_use_id=${d.toolUseId}`);
  }
  return out;
};

const CLEANUP_PIPELINE: MessageFilter[] = [
  migrateLegacyFormats,
  stripInvalidPermissionModes,
  filterUnresolvedToolUses,
  filterOrphanedThinkingOnlyMessages,
  filterWhitespaceOnlyAssistantMessages,
  validateContentBlockIntegrity,
  stripDanglingToolResultsFilter,
];

/**
 * 从末尾 tool_result 消息反查对应的工具名：按 tool_use_id 在整段历史里找发出它的 tool_use。
 *
 * 不能靠位置（以前取 messages[len-2]，不是 assistant 就返回 []）：位置索引在这个管道里不可靠——
 * 第 4/5 层会整条过滤 assistant 消息（纯 thinking 残留、被第 3 层/第 6 层剔空），第 6 层还会
 * 剔掉坏的 tool_use block，清洗后「tool_result 的前一条就是发出它的 assistant」不再成立，
 * 按位置查会拿到空列表，续接标记里就丢了工具名。
 *
 * 从末尾往前扫，每个待查 id 取**最近一次**出现的 tool_use 的 name：跨轮同 id 复用（缺陷 16）
 * 时，末尾这轮的结果对应的是它之前最近的那次调用，从前往后覆盖会取到旧轮的工具名。
 * 返回顺序与 resultMsg.content 中 tool_result 的出现顺序一致，且同名工具按结果数重复出现——
 * 调用方据此判断「是不是每个结果都还能归因」。查不到的 id 不编造，直接跳过。
 */
function findToolNamesForResults(messages: Message[], resultMsg: Message): string[] {
  const wantedIds = new Set<string>();
  for (const block of resultMsg.content) {
    if (block.type === "tool_result") wantedIds.add(block.tool_use_id);
  }
  if (wantedIds.size === 0) return [];

  // id 与 name 都是 API 必填字段，缺任何一项的 tool_use 不参与反查（第 6 层会另外剔除它们）
  const idToName = new Map<string, string>();
  for (let i = messages.length - 1; i >= 0 && idToName.size < wantedIds.size; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      if (!block.id || !block.name) continue;
      if (!wantedIds.has(block.id) || idToName.has(block.id)) continue;
      idToName.set(block.id, block.name);
    }
  }

  const names: string[] = [];
  for (const block of resultMsg.content) {
    if (block.type !== "tool_result") continue;
    const name = idToName.get(block.tool_use_id);
    if (name) names.push(name);
  }
  return names;
}

/**
 * 反序列化消息：先跑脏数据清洗管道，再检测中断状态
 */
export function deserializeMessagesWithInterruptDetection(
  serializedMessages: Message[],
): DeserializeResult {
  if (serializedMessages.length === 0) {
    return { messages: [], turnInterruptionState: { kind: "none" } };
  }

  const log = getLogger();
  const ctx: FilterContext = {
    log: (reason, detail) => log.debug("SESSION_RECOVERY", `[${reason}] ${detail}`),
  };

  let messages = serializedMessages;
  for (const filter of CLEANUP_PIPELINE) {
    messages = filter(messages, ctx);
  }

  if (messages.length === 0) {
    return { messages: [], turnInterruptionState: { kind: "none" } };
  }

  const lastMessage = messages[messages.length - 1];

  // 末尾是纯用户输入 → interrupted_prompt（用户问了但还没等到回复）
  if (lastMessage.role === "user") {
    const hasToolResult = lastMessage.content.some((b: ContentBlock) => b.type === "tool_result");
    if (!hasToolResult) {
      return {
        messages: messages.slice(0, -1),
        turnInterruptionState: { kind: "interrupted_prompt", message: lastMessage },
      };
    }

    // 末尾是 tool_result 且没有后续 assistant 回复 → Agent 执行完工具但被中断，
    // 还没来得及基于结果回复（P1-5：interrupted_turn）。
    return {
      messages,
      turnInterruptionState: {
        kind: "interrupted_turn",
        lastToolNames: findToolNamesForResults(messages, lastMessage),
      },
    };
  }

  // 末尾是 assistant 消息 → 正常结束
  return { messages, turnInterruptionState: { kind: "none" } };
}
