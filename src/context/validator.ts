/**
 * 消息验证器
 * 确保消息数组符合 Anthropic Messages API 的严格规则
 */

import type { Message } from "../llm/types.ts";

export interface ValidationError {
  code: string;
  message: string;
  messageIndex?: number;
}

export class MessageValidator {
  /**
   * 验证消息数组是否符合 API 规范
   * 返回错误列表，空数组表示验证通过
   */
  static validate(messages: Message[]): ValidationError[] {
    const errors: ValidationError[] = [];

    // 规则 1: 消息数组不能为空
    if (messages.length === 0) {
      errors.push({
        code: "EMPTY_MESSAGES",
        message: "消息数组不能为空",
      });
      return errors;
    }

    // 规则 2: 第一条消息必须是 user
    if (messages[0].role !== "user") {
      errors.push({
        code: "FIRST_MESSAGE_NOT_USER",
        message: "第一条消息必须是 user 角色",
        messageIndex: 0,
      });
    }

    // 规则 3: 角色必须交替
    for (let i = 1; i < messages.length; i++) {
      const prev = messages[i - 1];
      const curr = messages[i];
      if (prev.role === curr.role) {
        errors.push({
          code: "ROLE_NOT_ALTERNATING",
          message: `消息 ${i} 的角色与前一条相同，必须交替 (user/assistant)`,
          messageIndex: i,
        });
      }
    }

    // 规则 4: 内容不能为空
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg.content || msg.content.length === 0) {
        errors.push({
          code: "EMPTY_CONTENT",
          message: `消息 ${i} 的 content 数组为空`,
          messageIndex: i,
        });
      }
    }

    // 规则 5: tool_use_id 必须匹配
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          toolUseIds.add(block.id);
        } else if (block.type === "tool_result") {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }

    // 检查所有 tool_result 的 tool_use_id 是否都有对应的 tool_use
    for (const resultId of toolResultIds) {
      if (!toolUseIds.has(resultId)) {
        errors.push({
          code: "TOOL_USE_ID_MISMATCH",
          message: `tool_result 的 tool_use_id "${resultId}" 没有对应的 tool_use`,
        });
      }
    }

    // 规则 6: JSON 必须合法（工具输入）
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          try {
            // 尝试序列化，确保是有效的 JSON
            JSON.stringify(block.input);
          } catch {
            errors.push({
              code: "INVALID_TOOL_INPUT_JSON",
              message: `消息 ${i} 的 tool_use 输入不是有效的 JSON`,
              messageIndex: i,
            });
          }
        }
      }
    }

    return errors;
  }

  /**
   * 验证并抛出异常（如果有错误）
   */
  static validateOrThrow(messages: Message[]): void {
    const errors = this.validate(messages);
    if (errors.length > 0) {
      const errorMsg = errors.map(e => `[${e.code}] ${e.message}`).join("\n");
      throw new Error(`消息验证失败:\n${errorMsg}`);
    }
  }

  /**
   * 修复常见的消息格式问题（尽力而为）
   */
  static autoFix(messages: Message[]): Message[] {
    if (messages.length === 0) {
      return messages;
    }

    const fixed: Message[] = [];

    // 修复 1: 确保第一条是 user
    if (messages[0].role !== "user") {
      fixed.push({
        role: "user",
        content: [{ type: "text", text: "[系统] 开始对话" }],
      });
    }

    // 修复 2: 确保角色交替
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // 跳过空内容
      if (!msg.content || msg.content.length === 0) {
        continue;
      }

      // 检查是否需要插入占位消息
      if (fixed.length > 0 && fixed[fixed.length - 1].role === msg.role) {
        // 插入一个占位消息以保持交替
        const placeholderRole = msg.role === "user" ? "assistant" : "user";
        fixed.push({
          role: placeholderRole,
          content: [{ type: "text", text: "[系统] 占位消息" }],
        });
      }

      fixed.push(msg);
    }

    return fixed;
  }
}
