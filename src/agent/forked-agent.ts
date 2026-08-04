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
import type { LegacyTool, PermissionResult } from "../tool/types.ts";
import { validateToolInput } from "../tool/input-validator.ts";
import { getLogger } from "../debug/logger.ts";
import { normalizeToolInput } from "../llm/normalize-tool-input.ts";
import { resetOnStreamRestart, describeStreamRestart } from "../llm/stream-restart.ts";
import { SIDE_CALL_NO_THINK } from "../llm/side-call-timeout.ts";
import { streamWithResilience } from "../llm/resilient-stream.ts";
import type { ModelAvailabilityService } from "../llm/availability.ts";

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
  /**
   * B2：模型可用性服务。**应注入与主路径同一实例**，让 terminal 类错误（认证失败 /
   * 模型不存在 / 内容策略）跨路径共享拉黑——fork 撞到坏模型后，主路径与其它子代理
   * 下次不必各自再撞一次。缺省时漏斗自建独立实例（拉黑只在本次调用内有效）。
   */
  availability?: ModelAvailabilityService;
  /**
   * 注入的有状态工具（read / edit / read_many）——FileReadTracker 隔离用。
   *
   * forked agent 默认从 `toolRegistry` 取工具实例，会共享主代理的 FileReadTracker：
   * forked 读文件 A → 主代理 tracker 被 markAsRead → 主代理 edit A 时 validateForEdit
   * 误放行，绕过「先读后写」护栏（与子代理委托机制 §3 缺口 1 同源）。
   *
   * 调用方应传入 `createStatefulTools(new FileReadTracker())` 构造的独立工具实例，
   * 让 forked agent 用自己的 tracker，不污染主代理缓存。对标 cc `cloneFileStateCache`。
   * 工具执行时优先查这里，找不到再 fallback 到 toolRegistry（无 tracker 状态的工具）。
   * 未提供时退回旧行为（共享主注册表实例），保持向后兼容。
   */
  statefulTools?: LegacyTool[];
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
  signal?: AbortSignal,
): Promise<{ content: ContentBlock[]; stopReason: string | null; usage: { inputTokens: number; outputTokens: number } }> {
  const content: ContentBlock[] = [];
  let stopReason: string | null = null;
  const usage = { inputTokens: 0, outputTokens: 0 };
  const partialJson = new Map<number, string>();

  for await (const event of stream) {
    // B3 纵深防御：forked-agent 流消费中检查 signal，防止 abort 无法穿透底层时挂死
    // （对齐 agent/stream-processor.ts 的 B1 模式）
    if (signal?.aborted) {
      return { content: content.filter(Boolean), stopReason: "error", usage };
    }
    switch (event.type) {
      case "message_start":
        usage.inputTokens += event.message?.usage?.inputTokens ?? 0;
        break;
      // 流重开 → 上一次尝试的内容块全部作废（2026-08-04 事故根因修复）。
      // 与子代理/无头路径同构（按 index 落位 → 重开后残留高位块）。
      case "stream_restart": {
        const outcome = resetOnStreamRestart({ content, jsonAccumulators: partialJson });
        if (outcome.discardedBlocks > 0 || outcome.discardedTextLength > 0) {
          getLogger().warn("STREAM", describeStreamRestart(event, outcome));
        }
        break;
      }
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
          // O(n) 设计：拼接字符串 + 最终一次性解析，不做增量 parse（对齐 CC raw stream 策略）
          try {
            block.input = normalizeToolInput(raw ? JSON.parse(raw) : {});
          } catch (e) {
            // telemetry: 工具输入 JSON 解析失败（对齐 CC tengu_tool_input_json_parse_fail）
            getLogger().warn("STREAM", `工具输入 JSON 解析失败`, {
              toolName: block.name,
              inputLength: raw.length,
              error: e instanceof Error ? e.message : String(e),
              inputHead: raw.slice(0, 200),
            });
            block.input = {};
          }
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
  /** S3（§5 缺口 C）：与上面 timer 同源的截止时刻，透给漏斗做重试钳制。
   *
   *  fork 是最需要它的一条路径：预算只有 60s，而单次退避 cap 就是 120s——
   *  一次限流退避就足以把整个预算烧穿，且必然等不完就被 abort。有了它，漏斗会在
   *  "睡完也来不及发请求"时直接收手，把时间留给至少产出一个结论。 */
  const deadlineAt = Date.now() + timeoutMs;
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

  // FileReadTracker 隔离：注入的有状态工具按名建索引，工具执行时优先查这里，
  // 找不到再 fallback 到主注册表（grep/glob/ls/bash 等无 tracker 状态，复用无害）。
  // 未注入时此 Map 为空，所有工具都走 fallback——退回共享主注册表的旧行为。
  const statefulMap = new Map<string, LegacyTool>();
  for (const t of mainContext.statefulTools ?? []) {
    statefulMap.set(t.name(), t);
  }

  try {
    while (turns < options.maxTurns) {
      if (signal.aborted) break;
      turns++;

      // B2（D3）：走唯一漏斗，不再直连。
      //
      // fork agent 跑的是后台记忆提取 / session memory 更新——用户不可见，因此一次
      // 429 静默失败**没有任何人会注意到**，只会表现为"记忆偶尔不更新"这类查不出根因的
      // 玄学问题。恰恰是这种无人盯着的路径最需要自动重试。
      // switchMode 固定 auto：fork 无 TUI，ask 会挂死在等不到答案的 Promise 上。
      const stream = streamWithResilience(
        mainContext.provider,
        {
          model: mainContext.model,
          system: mainContext.systemPrompt,
          messages: conversation,
          maxTokens: 2048,
          tools: toolDefs,
          // H8：fork agent 执行窄范围任务（querySource 标注），无独立 effort 旋钮，默认关思考，
          // 与子代理收口口径一致（thinking 是受控旋钮，不放任沿用思考模型服务端默认 enabled）。
          thinking: SIDE_CALL_NO_THINK,
        },
        signal,
        {
          querySource: "agent:fork",
          switchMode: "auto",
          availability: mainContext.availability,
          // fork 自带 timeoutMs（默认 60s）作为 wall-clock 硬顶，退避会吃掉它的大半，
          // 故重试上界压到 2 次——给瞬时限流一个自愈机会，又不至于把整个预算烧在退避上。
          maxRetries: 2,
          // S3：次数上界（上面那行）是**静态猜测**，这个是**动态实测**——退避真到了
          // 塞不进剩余预算时提前收手。两者并存不冗余：前者防退避风暴，后者防白等。
          deadlineAt,
        },
      );

      const { content, stopReason, usage } = await accumulate(stream, signal);
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
        const tool = statefulMap.get(tu.name) ?? mainContext.toolRegistry.get(tu.name);
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
          // zod 运行时校验：用注入 _agentId 之前的原始 input 校验
          const validation = validateToolInput(tool, input);
          if (!validation.ok) {
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: validation.message,
              is_error: true,
            });
            continue;
          }
          // 注入 _agentId 标记，防止分叉代理调用 enter_plan_mode 形成套娃
          const res = await tool.execute({ ...(validation.data as Record<string, unknown>), _agentId: "forked-agent" }, signal);
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
