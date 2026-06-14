/**
 * Forked Agent 基础设施（Task 3）
 *
 * Forked Agent 是"完美分叉"的后台代理：与主对话共享 system prompt + 消息历史
 * 前缀（prompt cache 友好），在其后追加 promptMessages，用独立的工具权限
 * (canUseTool) 跑一个受限的 agentic 循环。
 *
 * 与 SubAgent 的区别：
 * - SubAgent: 独立短上下文(50K)，阻塞主循环，按类型预设白名单
 * - ForkedAgent: 共享主对话完整上下文，fire-and-forget，自定义 canUseTool
 *
 * 用途：后台记忆提取、Session Memory 更新——用户不可见的自动化任务。
 */

import type { Provider } from "../llm/provider.ts";
import type { Message, ContentBlock, ToolDefinition } from "../llm/types.ts";
import type { Registry as ToolRegistry } from "../tool/registry.ts";
import type { PermissionResult } from "../tool/types.ts";
import { getLogger } from "../debug/logger.ts";

/** 工具权限控制函数 */
export type CanUseToolFn = (
  toolName: string,
  input: unknown,
) => Promise<PermissionResult> | PermissionResult;

/** Forked Agent 主上下文（来自主对话） */
export interface ForkedAgentContext {
  systemPrompt: string;
  messages: Message[];
  provider: Provider;
  toolRegistry: ToolRegistry;
  model: string;
}

/** Forked Agent 选项 */
export interface ForkedAgentOptions {
  /** 注入到 forked agent 的提示消息（追加在主对话消息之后） */
  promptMessages: Message[];
  /** 工具权限控制函数 */
  canUseTool: CanUseToolFn;
  /** 硬性轮次上限（防止兔子洞） */
  maxTurns: number;
  /** 查询来源标识（用于日志和分析） */
  querySource: string;
  /** 超时（毫秒，默认 60000） */
  timeoutMs?: number;
  /** 中止信号 */
  signal?: AbortSignal;
}

/** Forked Agent 执行结果 */
export interface ForkedAgentResult {
  messages: Message[];
  usage: { inputTokens: number; outputTokens: number };
  turns: number;
  /** 被 canUseTool 拒绝的工具调用次数 */
  deniedToolCalls: number;
}

/** 收集 forked agent 可用的工具定义（受 canUseTool 约束的工具仍需声明给模型） */
function buildToolDefinitions(registry: ToolRegistry): ToolDefinition[] {
  return registry.definitions();
}

/** 累积一次流式响应 */
async function accumulate(
  stream: AsyncIterable<any>,
): Promise<{ content: ContentBlock[]; stopReason: string | null; usage: { inputTokens: number; outputTokens: number } }> {
  const content: ContentBlock[] = [];
  let stopReason: string | null = null;
  const usage = { inputTokens: 0, outputTokens: 0 };
  const partialJson = new Map<number, string>();

  for await (const event of stream) {
    switch (event.type) {
      case "message_start":
        usage.inputTokens += event.message?.usage?.inputTokens ?? 0;
        break;
      case "content_block_start":
        if (event.content_block?.type === "text") {
          content[event.index] = { type: "text", text: event.content_block.text ?? "" };
        } else if (event.content_block?.type === "tool_use") {
          content[event.index] = {
            type: "tool_use",
            id: event.content_block.id,
            name: event.content_block.name,
            input: {},
          };
          partialJson.set(event.index, "");
        }
        break;
      case "content_block_delta":
        if (event.delta?.type === "text_delta") {
          const block = content[event.index];
          if (block?.type === "text") block.text += event.delta.text;
        } else if (event.delta?.type === "input_json_delta") {
          partialJson.set(event.index, (partialJson.get(event.index) ?? "") + event.delta.partial_json);
        }
        break;
      case "content_block_stop": {
        const block = content[event.index];
        if (block?.type === "tool_use") {
          const raw = partialJson.get(event.index) ?? "";
          try { block.input = raw ? JSON.parse(raw) : {}; } catch { block.input = {}; }
        }
        break;
      }
      case "message_delta":
        stopReason = event.delta?.stop_reason ?? stopReason;
        usage.outputTokens += event.usage?.outputTokens ?? 0;
        break;
    }
  }
  return { content: content.filter(Boolean), stopReason, usage };
}

/**
 * 运行一个 forked agent。
 *
 * fire-and-forget：调用方可 await 或直接丢弃 Promise。
 * 返回追加的消息序列（promptMessages + 模型响应 + 工具结果）与用量统计。
 */
export async function runForkedAgent(
  mainContext: ForkedAgentContext,
  options: ForkedAgentOptions,
): Promise<ForkedAgentResult> {
  const log = getLogger();
  const timeoutMs = options.timeoutMs ?? 60_000;

  // 组合超时与外部 signal
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  // forked 消息序列：主对话历史前缀（缓存友好）+ 追加的提示消息
  // 对主历史做结构化克隆,隔离于主上下文——避免主循环就地 mutation 污染
  // forked 正在读取的同一批消息对象(CONTEXT-MEMORY-8)。内容不变,不影响 prompt 缓存。
  let clonedPrefix: Message[];
  try {
    clonedPrefix = structuredClone(mainContext.messages) as Message[];
  } catch {
    // 极端情况下消息含不可克隆字段时,退回浅拷贝(至少数组独立)
    clonedPrefix = [...mainContext.messages];
  }
  const conversation: Message[] = [...clonedPrefix, ...options.promptMessages];
  const appended: Message[] = [...options.promptMessages];
  const totalUsage = { inputTokens: 0, outputTokens: 0 };
  let turns = 0;
  let deniedToolCalls = 0;

  const toolDefs = buildToolDefinitions(mainContext.toolRegistry);

  try {
    while (turns < options.maxTurns) {
      if (signal.aborted) break;
      turns++;

      const stream = mainContext.provider.sendMessageStream(
        {
          model: mainContext.model,
          system: mainContext.systemPrompt,
          messages: conversation,
          maxTokens: 2048,
          tools: toolDefs,
        },
        signal,
      );

      const { content, stopReason, usage } = await accumulate(stream);
      totalUsage.inputTokens += usage.inputTokens;
      totalUsage.outputTokens += usage.outputTokens;

      const assistantMsg: Message = { role: "assistant", content };
      conversation.push(assistantMsg);
      appended.push(assistantMsg);

      // 收集 tool_use
      const toolUses = content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
      if (toolUses.length === 0 || stopReason === "end_turn") {
        break; // 无工具调用，结束
      }

      // 执行工具（受 canUseTool 约束）
      const results: ContentBlock[] = [];
      for (const tu of toolUses) {
        const decision = await options.canUseTool(tu.name, tu.input);
        if (decision.behavior !== "allow") {
          deniedToolCalls++;
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `权限拒绝: ${decision.behavior === "deny" ? decision.message : "工具不可用"}`,
            is_error: true,
          });
          continue;
        }
        const tool = mainContext.toolRegistry.get(tu.name);
        if (!tool) {
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `工具不存在: ${tu.name}`,
            is_error: true,
          });
          continue;
        }
        try {
          const input = (decision as { updatedInput?: unknown }).updatedInput ?? tu.input;
          // 注入 _agentId 标记，防止分叉代理调用 enter_plan_mode 形成套娃
          const res = await tool.execute({ ...(input as Record<string, unknown>), _agentId: "forked-agent" }, signal);
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: res.output,
            is_error: res.isError,
          });
        } catch (err: any) {
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `工具执行失败: ${err.message}`,
            is_error: true,
          });
        }
      }

      const toolResultMsg: Message = { role: "user", content: results };
      conversation.push(toolResultMsg);
      appended.push(toolResultMsg);
    }
  } catch (err: any) {
    if (err?.name !== "AbortError") {
      log.debug("FORKED", `forked agent (${options.querySource}) 出错: ${err.message}`);
    }
  } finally {
    clearTimeout(timer);
  }

  log.debug(
    "FORKED",
    `forked agent (${options.querySource}) 完成: ${turns} 轮, ${deniedToolCalls} 次拒绝, ` +
      `${totalUsage.inputTokens}/${totalUsage.outputTokens} tokens`,
  );

  return { messages: appended, usage: totalUsage, turns, deniedToolCalls };
}
