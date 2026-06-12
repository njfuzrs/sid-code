/**
 * Headless 入口 — 子代理独立进程
 *
 * Wave 2 (Spawn 模式)：由父进程通过 Bun.spawn 启动。
 *
 * 职责：
 * - 从 stdin 读取 init 消息
 * - 创建 LLM Provider，运行 Agent Loop
 * - 工具调用回传父进程（通过 stdout/stderr）
 * - 结果/崩溃消息写入 stdout
 *
 * 子进程不做的事（由父进程做）：
 * - ❌ 工具执行（execute 实现）
 * - ❌ 权限检查 / Hook / MCP / Plan Mode / TUI
 */

import {
  type ParentInitMessage,
  type ParentToolResultMessage,
  type ParentSignalMessage,
  type ChildMessage,
  writeChildMsg,
  readLineFromStream,
} from "../agent/sub-agent-protocol.ts";
import type { Provider } from "../llm/provider.ts";
import type {
  ContentBlock,
  StreamEvent,
  Usage,
  ToolDefinition,
} from "../llm/types.ts";
import { accumulateUsage } from "../llm/types.ts";

// ============================================================
// 主线
// ============================================================

async function main(): Promise<void> {
  // 子进程静默 stderr（避免干扰 stdout NDJSON）
  const logError = (...args: unknown[]) => {
    process.stderr.write(args.map(String).join(" ") + "\n");
  };

  try {
    // 1. 读取 init 消息（使用 Bun.stdin.stream() 获取 ReadableStream）
    const stdinStream = Bun.stdin.stream();
    const stdinReader = stdinStream.getReader();
    const decoder = new TextDecoder();
    const buffer = { value: "" };
    const initLine = await readLineFromStream(stdinReader, decoder, buffer);

    if (!initLine) {
      logError("[headless] stdin 在 init 消息前关闭");
      process.exit(1);
    }

    let init: ParentInitMessage;
    try {
      init = JSON.parse(initLine);
    } catch {
      logError("[headless] init 消息 JSON 解析失败:", initLine.slice(0, 200));
      process.exit(1);
    }

    if (init.type !== "init") {
      logError(`[headless] 期望 init 消息，收到: ${init.type}`);
      process.exit(1);
    }

    // 发送就绪信号
    writeChildMsg({ type: "ready" });

    // 2. 创建 Provider
    const provider = createProvider(
      init.provider_name,
      init.model,
      init.api_key,
      init.base_url,
    );

    // 3. 运行 Agent Loop
    await runAgentLoop(
      provider,
      init,
      stdinReader,
      decoder,
      buffer,
      logError,
    );
  } catch (err: any) {
    // 未捕获异常 → 发送 crash 消息
    try {
      writeChildMsg({
        type: "crash",
        error: err.message,
        stack: err.stack?.slice(0, 500),
      });
    } catch { /* 忽略 — stdout 可能已关闭 */ }
    logError("[headless] 未捕获异常:", err.message);
    process.exit(1);
  }
}

// ============================================================
// Agent Loop
// ============================================================

/**
 * 运行 Agent Loop。
 *
 * 流程：
 * 1. 初始化 ContextManager
 * 2. 循环调用 LLM → 处理响应 → 工具调用回传父进程 → 等待结果 → 继续
 * 3. 遇到 end_turn 时发送 result 消息并退出
 */
async function runAgentLoop(
  provider: Provider,
  init: ParentInitMessage,
  stdinReader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buffer: { value: string },
  logError: (...args: unknown[]) => void,
): Promise<void> {
  const { Manager: ContextManager } = await import("../context/manager.ts");

  const ctxMgr = new ContextManager({
    maxTokens: init.max_tokens,
  });

  ctxMgr.setSystemPrompt(init.system_prompt);
  ctxMgr.addMessage({
    role: "user",
    content: [{ type: "text", text: init.user_prompt }],
  });

  // 超时定时器
  const timeoutId = setTimeout(() => {
    writeChildMsg({
      type: "crash",
      error: `子代理超时 (${Math.round(init.timeout / 1000)}秒)`,
    });
    process.exit(1);
  }, init.timeout);
  // 不让定时器阻止进程退出
  if (timeoutId.unref) timeoutId.unref();

  const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  let turns = 0;
  let lastTextOutput = "";
  let toolUseCount = 0;

  try {
    while (turns < init.max_turns) {
      turns++;

      // 发送进度（可选）
      writeChildMsg({ type: "progress", turn: turns, max_turns: init.max_turns });

      // 调用 LLM
      const toolDefs = init.tool_defs.length > 0
        ? init.tool_defs.map(d => ({
            name: d.name,
            description: d.description,
            input_schema: d.inputSchema, // camelCase → snake_case
          }))
        : undefined;

      const stream = provider.sendMessageStream({
        model: init.model,
        messages: ctxMgr.getMessages(),
        system: ctxMgr.getSystemPrompt(),
        maxTokens: 4096,
        tools: toolDefs,
      });

      // 处理流式响应
      const response = await processStream(stream);

      totalUsage.inputTokens += response.usage.inputTokens;
      totalUsage.outputTokens += response.usage.outputTokens;

      // 提取文本输出
      const textBlocks = response.content.filter(b => b.type === "text");
      if (textBlocks.length > 0) {
        lastTextOutput = textBlocks
          .map(b => (b.type === "text" ? b.text : ""))
          .join("\n");
      }

      ctxMgr.addMessage({
        role: "assistant",
        content: response.content,
      });

      // 检查停止原因
      if (
        response.stopReason === "end_turn" ||
        response.stopReason === "stop"
      ) {
        // 正常结束
        writeChildMsg({
          type: "result",
          success: true,
          output: lastTextOutput,
          usage: totalUsage,
          turns,
          toolUseCount,
        });
        return;
      }

      // 处理工具调用
      if (response.stopReason === "tool_use") {
        // 收集所有 tool_use blocks
        const toolUses = response.content
          .filter((b): b is ContentBlock & { type: "tool_use" } => b.type === "tool_use");

        if (toolUses.length === 0) {
          // 没有工具调用但 stop_reason 是 tool_use (异常)
          writeChildMsg({
            type: "result",
            success: false,
            output: "LLM 返回 tool_use stop_reason 但没有工具调用",
            usage: totalUsage,
            turns,
            toolUseCount,
          });
          return;
        }

        // 统计工具调用
        toolUseCount += toolUses.length;

        // 发送所有 tool_use 消息给父进程
        for (const tu of toolUses) {
          writeChildMsg({
            type: "tool_use",
            id: tu.id,
            name: tu.name,
            input: tu.input,
          });
        }

        // 逐条读取父进程返回的 tool_result
        const toolResults: ContentBlock[] = [];
        for (const tu of toolUses) {
          const line = await readLineFromStream(stdinReader, decoder, buffer);

          if (!line) {
            // stdin 关闭 = 父进程已中止
            logError("[headless] stdin 关闭，父进程可能已中止");
            return;
          }

          let resultMsg: ParentToolResultMessage | ParentSignalMessage;
          try {
            resultMsg = JSON.parse(line);
          } catch {
            logError("[headless] tool_result JSON 解析失败:", line.slice(0, 200));
            toolResults.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: "父进程返回无效消息",
              is_error: true,
            });
            continue;
          }

          if (resultMsg.type === "signal") {
            // 收到 abort 信号
            logError("[headless] 收到父进程 abort 信号");
            return;
          }

          if (resultMsg.type === "tool_result") {
            toolResults.push({
              type: "tool_result",
              tool_use_id: resultMsg.tool_use_id,
              content: resultMsg.content,
              is_error: resultMsg.is_error,
            });
          }
        }

        // 将 tool_results 注入上下文
        ctxMgr.addMessage({
          role: "user",
          content: toolResults,
        });
        continue;
      }

      // 未知 stop_reason → 退出
      writeChildMsg({
        type: "result",
        success: true,
        output: lastTextOutput,
        usage: totalUsage,
        turns,
        toolUseCount,
      });
      return;
    }

    // 达到最大轮次
    writeChildMsg({
      type: "result",
      success: true,
      output: lastTextOutput || `已达到最大轮次 (${init.max_turns})`,
      usage: totalUsage,
      turns,
      toolUseCount,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================
// 流式响应处理
// ============================================================

/** 处理 LLM 流式响应，返回累积结果 */
async function processStream(stream: AsyncIterable<StreamEvent>): Promise<{
  content: ContentBlock[];
  stopReason: string | null;
  usage: Usage;
}> {
  const content: ContentBlock[] = [];
  let stopReason: string | null = null;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const jsonAccumulators = new Map<number, string>();

  for await (const event of stream) {
    switch (event.type) {
      case "message_start":
        accumulateUsage(usage, event.message.usage);
        break;

      case "content_block_start":
        if (event.content_block.type === "text") {
          content[event.index] = { type: "text", text: "" };
        } else if (event.content_block.type === "tool_use") {
          content[event.index] = {
            type: "tool_use",
            id: event.content_block.id,
            name: event.content_block.name,
            input: {},
          };
          jsonAccumulators.set(event.index, "");
        }
        break;

      case "content_block_delta": {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          const block = content[event.index];
          if (block?.type === "text") {
            block.text += delta.text;
          }
        } else if (delta.type === "input_json_delta") {
          const acc = jsonAccumulators.get(event.index) ?? "";
          jsonAccumulators.set(event.index, acc + delta.partial_json);
        }
        break;
      }

      case "content_block_stop": {
        const jsonStr = jsonAccumulators.get(event.index);
        if (jsonStr !== undefined) {
          const block = content[event.index];
          if (block?.type === "tool_use") {
            try {
              block.input = jsonStr ? JSON.parse(jsonStr) : {};
            } catch {
              block.input = {};
            }
          }
          jsonAccumulators.delete(event.index);
        }
        break;
      }

      case "message_delta":
        stopReason = event.delta.stop_reason;
        accumulateUsage(usage, event.usage);
        break;

      case "error":
        throw new Error(`LLM 错误: ${event.error.message}`);
    }
  }

  return { content, stopReason, usage };
}

// ============================================================
// Provider 工厂
// ============================================================

/** 根据配置创建 Provider 实例（与 registry.ts createProvider 逻辑一致） */
function createProvider(
  name: string,
  model: string,
  apiKey: string,
  baseURL?: string,
): Provider {
  switch (name) {
    case "anthropic": {
      // 动态导入避免顶层阻塞
      const { AnthropicProvider } = require("../llm/anthropic.ts");
      return new AnthropicProvider(apiKey, model, baseURL);
    }
    case "openai": {
      const { OpenAIProvider } = require("../llm/openai.ts");
      return new OpenAIProvider(apiKey, model, baseURL);
    }
    case "ollama": {
      const { OllamaProvider } = require("../llm/ollama.ts");
      return new OllamaProvider(model, baseURL);
    }
    default:
      throw new Error(`未知的 Provider: ${name}`);
  }
}

// ============================================================
// 启动（仅在直接运行时执行，import 时不执行）
// ============================================================

// Bun: import.meta.main 不可用，改用 process.argv 判断
const isEntryPoint = process.argv[1]?.endsWith("headless.ts");
if (isEntryPoint) {
  main();
}
