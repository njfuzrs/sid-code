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
  writeChildMsg,
  readLineFromStream,
} from "@sid-code/core/agent/sub-agent-protocol.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import { describeToolActivity } from "@sid-code/core/agent/progress.ts";
import type { ContentBlock, StreamEvent, Usage } from "@sid-code/core/llm/types.ts";
import { accumulateUsage } from "@sid-code/core/llm/types.ts";
import { normalizeToolInput } from "@sid-code/core/llm/normalize-tool-input.ts";
import { resetOnStreamRestart, describeStreamRestart } from "@sid-code/core/llm/stream-restart.ts";
import { getLogger } from "@sid-code/core/debug/index.ts";
import { SIDE_CALL_NO_THINK } from "@sid-code/core/llm/side-call-timeout.ts";
import { streamWithResilience } from "@sid-code/core/llm/resilient-stream.ts";

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

    // 别名表播种（纵深防御）：本进程不读 settings.json、不跑 loadConfig，别名表恒为空。
    // 逐个调用点传 wireModel 只能覆盖**当前已知**的发送点；播种进表后，本进程内任何路径
    // （含日后新增的发送点、以及 ModelFallback 的重试/降级路径）都自动拿到真名。
    //
    // 优先用父进程传来的**整张表**：单条 wire_model 只覆盖「本次要发的模型」，而
    // ModelFallback 降级时会**换模型**并靠这张表翻译新目标（fallback.ts 刻意把
    // wireModel 置 undefined）。只播种主模型一条 → fallback 目标查不到 → 原样发别名
    // → 400，而降级恰恰是主模型已经出问题时才跑的最后一道防线。
    // 老版本父进程只发 wire_model 时退回单条播种（向后兼容）；两者都缺省时表为空、行为不变。
    {
      const {
        setWireModelAliasesFromMap,
        setWireModelAliases,
      } = require("@sid-code/core/llm/wire-model.ts");
      if (init.wire_model_aliases) {
        setWireModelAliasesFromMap(init.wire_model_aliases);
      } else if (init.wire_model) {
        setWireModelAliases([{ name: init.model, modelId: init.wire_model }]);
      }
    }

    // compat 声明表播种（与上面别名表同一个理由）：子进程不读配置文件，进程级表默认为空。
    // 不播种则父进程按用户声明发字段、子进程按内置判定发字段 —— 同一份配置两种行为且不报错。
    // 老版本父进程不发该字段时表为空、行为与此前完全一致（向后兼容）。
    {
      const { setModelCompatFromMap } = require("@sid-code/core/llm/model-compat.ts");
      if (init.model_compat) setModelCompatFromMap(init.model_compat);
    }

    // 2. 创建 Provider
    const provider = createProvider(init.provider_name, init.model, init.api_key, init.base_url);

    // 3. 运行 Agent Loop
    await runAgentLoop(provider, init, stdinReader, decoder, buffer, logError);
  } catch (err: any) {
    // 未捕获异常 → 发送 crash 消息
    try {
      writeChildMsg({
        type: "crash",
        error: err.message,
        stack: err.stack?.slice(0, 500),
      });
    } catch {
      /* 忽略 — stdout 可能已关闭 */
    }
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
  const { Manager: ContextManager } = await import("@sid-code/core/context/manager.ts");

  const ctxMgr = new ContextManager({
    maxTokens: init.max_tokens,
    // 传 session_id → 创建即启用工具输出遮罩（对标 cc：headless 是评估/CI/批量入口，
    // 长任务跑批时最需要 masking 压 input token，此前裸发完全没有）。
    sessionId: init.session_id,
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

  // P0/P1-2：初始化补齐缓存字段，回传父进程的 totalUsage 才能携带命中/写入量，
  // 否则父会话 sink 按全价计费、子代理缓存省钱失真。
  const totalUsage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  let turns = 0;
  let lastTextOutput = "";
  let toolUseCount = 0;

  // 计费口径修复：result 显式回传子代理实际 model/provider（来自 init），
  // 父进程归集时按此计价，不再依赖兜底；spawn 与进程内模式口径一致。
  const emitResult = (success: boolean, output: string): void => {
    writeChildMsg({
      type: "result",
      success,
      output,
      usage: totalUsage,
      turns,
      toolUseCount,
      model: init.model,
      provider: init.provider_name,
    });
  };

  try {
    while (turns < init.max_turns) {
      turns++;

      // 调用 LLM
      const toolDefs =
        init.tool_defs.length > 0
          ? init.tool_defs.map((d) => ({
              name: d.name,
              description: d.description,
              input_schema: d.inputSchema, // camelCase → snake_case
              // 审计第 18 条：透传 strict（Constrained Decoding），此前手写映射丢失此字段。
              ...(d.strict !== undefined ? { strict: d.strict } : {}),
            }))
          : undefined;

      // B2（D4）：走唯一漏斗，不再直连。
      //
      // 无头子进程是韧性最差的一条路径：它没有 TUI、没有父进程的重试兜底，
      // 一次 429 就整进程失败退出，父进程只收到一句 result{success:false}。
      // switchMode 必须 auto——**绝不阻塞**：ask 会去调一个此进程里根本不存在的
      // TUI 钩子，把子进程永久挂死，比失败更糟。
      const stream = streamWithResilience(
        provider,
        {
          // 别名（归因/日志口径，与父进程一致）
          model: init.model,
          // 真名：本进程不读配置、别名表恒空，只能用父进程随 init 传来的值。
          // 缺省（老版本父进程 / 无 model_id 配置）时 provider 回落 model，行为不变。
          wireModel: init.wire_model,
          // 发给 LLM 走 getCleanedMessages()（剪枝 + masking），对标主循环与 agentic-loop。
          messages: ctxMgr.getCleanedMessages(),
          system: ctxMgr.getSystemPrompt(),
          maxTokens: 4096,
          tools: toolDefs,
          // H8：headless（spawn 出的独立进程子代理）入口无独立 effort 旋钮，默认关思考，
          // 与进程内子代理/fork 收口口径一致（ParentInitMessage 不携带 effort）。
          thinking: SIDE_CALL_NO_THINK,
        },
        undefined,
        {
          querySource: "headless",
          switchMode: "auto",
          // 父进程用 init.timeout 做 wall-clock 硬顶（`sub-agent.ts` 超时即 kill 子进程），
          // 故此处上界压到 3 次，避免退避把父进程那份预算烧穿后被硬 kill——
          // 那样重试反而**降低**成功率（连收尾的 result 消息都发不出去）。
          maxRetries: 3,
        },
      );

      // 处理流式响应
      const response = await processStream(stream);

      // P0/P1-2：统一走 accumulateUsage，补齐 cacheRead/cacheCreation，
      // 与 query/agent/agentic-loop 三处口径一致（消灭第四套拷贝的丢字段缺陷）。
      accumulateUsage(totalUsage, response.usage);

      // 提取文本输出
      const textBlocks = response.content.filter((b) => b.type === "text");
      if (textBlocks.length > 0) {
        lastTextOutput = textBlocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      }

      ctxMgr.addMessage({
        role: "assistant",
        content: response.content,
      });

      // 实时进度上报：带真实累计 token / 工具次数 / 最后活动文案，供父进程刷新 TUI 面板。
      // 必须在 accumulateUsage 之后发，token 才是本轮真实值（非伪造估算）。
      {
        const turnToolUses = response.content.filter(
          (b): b is ContentBlock & { type: "tool_use" } => b.type === "tool_use",
        );
        const lastTool = turnToolUses[turnToolUses.length - 1];
        writeChildMsg({
          type: "progress",
          turn: turns,
          max_turns: init.max_turns,
          toolUseCount: toolUseCount + turnToolUses.length,
          tokenCount: totalUsage.inputTokens + totalUsage.outputTokens,
          lastActivity: lastTool ? describeToolActivity(lastTool.name, lastTool.input) : undefined,
        });
      }

      // 检查停止原因
      if (response.stopReason === "end_turn" || response.stopReason === "stop") {
        // 正常结束
        emitResult(true, lastTextOutput);
        return;
      }

      // 处理工具调用
      if (response.stopReason === "tool_use") {
        // 收集所有 tool_use blocks
        const toolUses = response.content.filter(
          (b): b is ContentBlock & { type: "tool_use" } => b.type === "tool_use",
        );

        if (toolUses.length === 0) {
          // 没有工具调用但 stop_reason 是 tool_use (异常)
          emitResult(false, "LLM 返回 tool_use stop_reason 但没有工具调用");
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
            input: tu.input as Record<string, unknown>,
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
      emitResult(true, lastTextOutput);
      return;
    }

    // 达到最大轮次
    emitResult(true, lastTextOutput || `已达到最大轮次 (${init.max_turns})`);
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

      // 流重开 → 上一次尝试的内容块全部作废（2026-08-04 事故根因修复）。
      // 与子代理路径同构（按 index 落位 → 重开后残留高位块），故同样必须清。
      // 无头/评估模式尤其要修：错乱响应会静默污染评估样本，而这里没有人盯着屏幕。
      case "stream_restart": {
        const outcome = resetOnStreamRestart({ content, jsonAccumulators });
        if (outcome.discardedBlocks > 0 || outcome.discardedTextLength > 0) {
          getLogger().warn("STREAM", describeStreamRestart(event, outcome));
        }
        break;
      }

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
            // O(n) 设计：拼接字符串 + 最终一次性解析，不做增量 parse（对齐 CC raw stream 策略）
            try {
              block.input = normalizeToolInput(jsonStr ? JSON.parse(jsonStr) : {});
            } catch (e) {
              // telemetry: 工具输入 JSON 解析失败（对齐 CC tengu_tool_input_json_parse_fail）
              getLogger().warn("STREAM", `工具输入 JSON 解析失败`, {
                toolName: block.name,
                inputLength: jsonStr.length,
                error: e instanceof Error ? e.message : String(e),
                // 取前 200 字符辅助调试（不泄露完整输入，可能含敏感数据）
                inputHead: jsonStr.slice(0, 200),
              });
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
function createProvider(name: string, model: string, apiKey: string, baseURL?: string): Provider {
  switch (name) {
    case "anthropic": {
      // 动态导入避免顶层阻塞
      const { AnthropicProvider } = require("@sid-code/core/llm/anthropic.ts");
      return new AnthropicProvider(apiKey, model, baseURL);
    }
    case "openai": {
      const { OpenAIProvider } = require("@sid-code/core/llm/openai.ts");
      return new OpenAIProvider(apiKey, model, baseURL);
    }
    case "ollama": {
      const { OllamaProvider } = require("@sid-code/core/llm/ollama.ts");
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
