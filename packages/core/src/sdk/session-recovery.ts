/**
 * 会话中断检测与恢复
 *
 * 从持久化的消息历史恢复会话时，跑一条脏数据清洗管道（P0-2），再检测上一次运行
 * 是否在中途被中断（P1-5）：
 *
 * 清洗管道（依次执行，每层只做一件事，方便排查恢复问题时定位是哪层丢的数据）：
 *   1. migrateLegacyFormats          —— 格式迁移预留点（兼容旧版本消息结构）
 *   2. stripInvalidPermissionModes   —— 清理引用了已下线权限模式的 _meta 字段
 *   3. filterUnresolvedToolUses      —— 过滤有 tool_use 但无对应 tool_result 的调用
 *   4. filterOrphanedThinkingOnlyMessages —— 过滤流式中断残留的纯 thinking assistant 消息
 *   5. filterWhitespaceOnlyAssistantMessages —— 过滤内容被清空后的空白 assistant 消息
 *   6. validateContentBlockIntegrity —— 剔除缺失关键字段（id/name/tool_use_id）的不完整 block
 *
 * 中断检测三态（对齐 CC 的 none / interrupted_prompt / interrupted_turn）：
 *   - none              正常结束：最后一条是 assistant 消息，或末尾 tool_result 全部
 *                        来自终结性工具（TERMINAL_TOOL_NAMES 白名单）
 *   - interrupted_prompt 用户输入了但 Agent 还没开始回复（末尾是纯文本 user 消息）
 *   - interrupted_turn   Agent 执行完工具但还没来得及回复就被中断（末尾是非终结性
 *                        工具的 tool_result）
 *
 * 对齐 Claude Code deserializeMessagesWithInterruptDetection（spec §5.4）。
 */

import type { ContentBlock, Message } from "../llm/types.ts";
import { getLogger } from "../debug/logger.ts";

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

/**
 * 终结性工具白名单：这些工具合法以 tool_result 结尾（不算中断）。
 * 目前为空——sid-code 尚无"调用后即合法终止对话"的工具（对标 CC 的 Brief/SendUserFile
 * 之类）。导出供未来接入此类工具时登记，也方便单测直接验证白名单生效路径。
 */
export const TERMINAL_TOOL_NAMES = new Set<string>();

/** 有效的权限模式集合（P0-2 第 2 层用）。与 permission/types.ts 的模式枚举保持一致；
 *  历史消息 _meta.permissionMode 若引用了不在此列表中的值，视为已下线，清理之。 */
const VALID_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "always-allow",
]);

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

/** 第 3 层：过滤未解析的 tool_use（有 tool_use 但无对应 tool_result）—— 否则 API 报错 */
const filterUnresolvedToolUses: MessageFilter = (messages, ctx) => {
  const resolvedToolUseIds = new Set<string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_result") resolvedToolUseIds.add(block.tool_use_id);
    }
  }
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const filteredContent = msg.content.filter((block) => {
      if (block.type === "tool_use" && !resolvedToolUseIds.has(block.id)) {
        ctx.log("未解析tool_use过滤", `丢弃 tool_use id=${block.id} name=${block.name}`);
        return false;
      }
      return true;
    });
    return filteredContent.length === msg.content.length
      ? msg
      : { ...msg, content: filteredContent };
  });
};

/** 第 4 层：孤立 thinking-only 消息过滤——流式中断可能残留只有 thinking/redacted_thinking
 *  block 的 assistant 消息（模型还没来得及产出正文就被打断），这类消息对续接无意义，
 *  且部分 provider 会拒绝只含 thinking 块的消息。 */
const filterOrphanedThinkingOnlyMessages: MessageFilter = (messages, ctx) => {
  return messages.filter((msg) => {
    if (msg.role !== "assistant" || msg.content.length === 0) return true;
    const hasNonThinking = msg.content.some(
      (b) => b.type !== "thinking" && b.type !== "redacted_thinking",
    );
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
 *  这类消息发给 API 必定 400，不如恢复阶段就主动剔除。 */
const validateContentBlockIntegrity: MessageFilter = (messages, ctx) => {
  return messages.filter((msg) => {
    for (const block of msg.content) {
      if (block.type === "tool_use" && (!block.id || !block.name)) {
        ctx.log("contentBlock完整性校验", "丢弃缺失 id/name 的不完整 tool_use block 所在消息");
        return false;
      }
      if (block.type === "tool_result" && !block.tool_use_id) {
        ctx.log(
          "contentBlock完整性校验",
          "丢弃缺失 tool_use_id 的不完整 tool_result block 所在消息",
        );
        return false;
      }
    }
    return true;
  });
};

const CLEANUP_PIPELINE: MessageFilter[] = [
  migrateLegacyFormats,
  stripInvalidPermissionModes,
  filterUnresolvedToolUses,
  filterOrphanedThinkingOnlyMessages,
  filterWhitespaceOnlyAssistantMessages,
  validateContentBlockIntegrity,
];

/** 从末尾 tool_result 消息反查对应的工具名（在倒数第二条 assistant 消息的 tool_use 里找） */
function findToolNamesForResults(messages: Message[], resultMsg: Message): string[] {
  const prev = messages[messages.length - 2];
  if (!prev || prev.role !== "assistant") return [];
  const idToName = new Map<string, string>();
  for (const block of prev.content) {
    if (block.type === "tool_use") idToName.set(block.id, block.name);
  }
  const names: string[] = [];
  for (const block of resultMsg.content) {
    if (block.type === "tool_result") {
      const name = idToName.get(block.tool_use_id);
      if (name) names.push(name);
    }
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
    const toolNames = findToolNamesForResults(messages, lastMessage);
    const allTerminal = toolNames.length > 0 && toolNames.every((n) => TERMINAL_TOOL_NAMES.has(n));
    if (allTerminal) {
      // 白名单内的终结性工具（如未来的 Brief/SendUserFile）合法以 tool_result 结尾，不算中断
      return { messages, turnInterruptionState: { kind: "none" } };
    }
    return {
      messages,
      turnInterruptionState: { kind: "interrupted_turn", lastToolNames: toolNames },
    };
  }

  // 末尾是 assistant 消息 → 正常结束
  return { messages, turnInterruptionState: { kind: "none" } };
}
