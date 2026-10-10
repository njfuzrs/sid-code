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
import type { Message, ContentBlock, ToolDefinition, Usage } from "../llm/types.ts";
import type { Registry as ToolRegistry } from "../tool/registry.ts";
import type { LegacyTool, PermissionResult } from "../tool/types.ts";
import { validateToolInput } from "../tool/input-validator.ts";
import { getLogger } from "../debug/logger.ts";
import { normalizeToolInput } from "../llm/normalize-tool-input.ts";
import { resetOnStreamRestart, recordStreamRestart } from "../llm/stream-restart.ts";
import { SIDE_CALL_NO_THINK } from "../llm/side-call-timeout.ts";
import { streamWithResilience } from "../llm/resilient-stream.ts";
import type { ModelAvailabilityService } from "../llm/availability.ts";
// 漏斗 2 · 权限：走门面而非直调 logEvent（门面强制脱敏工具名）。
import {
  logPermissionAllow,
  logPermissionDeny,
  logToolCall,
  logToolFailure,
  logToolSuccess,
} from "../analytics/events.ts";
import { getTelemetryBus } from "../telemetry/index.ts";
import { ATTR } from "../telemetry/types.ts";
import { maskedErrorSummary, sanitizedToolName } from "../telemetry/content-tracing.ts";
import { FileReadTracker } from "../tool/file-read-tracker.ts";
import { createStatefulTools } from "../tool/stateful-tools.ts";

/** 工具权限控制函数 */
export type CanUseToolFn = (
  toolName: string,
  input: unknown,
) => Promise<PermissionResult> | PermissionResult;

/**
 * forked 路径的 `execute_tool` span（缺陷 30，20260927 可观测性审计）。
 *
 * 主循环 / 子代理的 execute_tool span 由 hook-probe 订阅 PostToolUse 产生；forked
 * **刻意不 fire 用户 hook**（调用方全是内部旁路：记忆抽取 / dream / session-memory /
 * `/btw`，fire 出去会让用户的 PreToolUse 拦截与通知被内部 side-call 刷屏、甚至改写
 * 内部工具参数，理由同上方 B33 对 PermissionDenied 的处理）。所以这里**直接**上总线
 * 起 span，而不是借道 hook —— 观测要补，用户 hook 的语义面不扩。
 *
 * 与 hook-probe 同口径：工具名过 sanitizeToolName、错误摘要过脱敏、起点按耗时回填。
 * detached：forked 常与主循环并发（后台记忆抽取），不能进 traceContext 栈（缺陷 2）。
 * 全程 try/catch：可观测性绝不影响 forked 主流程。
 */
function recordForkedToolSpan(
  toolName: string,
  toolUseId: string,
  querySource: string,
  outcome: { durationMs: number; isError: boolean; error?: string },
): void {
  try {
    const name = sanitizedToolName(toolName);
    const span = getTelemetryBus().startSpan(
      "execute_tool",
      `execute_tool ${name}`,
      {
        [ATTR.OPERATION_NAME]: "execute_tool",
        [ATTR.TOOL_NAME]: name,
        [ATTR.TOOL_CALL_ID]: toolUseId,
        [ATTR.SUCCESS]: !outcome.isError,
        "sidcode.tool.duration_ms": outcome.durationMs,
        "sidcode.execution_context": "forked",
        "sidcode.forked.query_source": querySource,
      },
      { startTime: Date.now() - Math.max(0, outcome.durationMs), detached: true },
    );
    if (outcome.isError) span.recordError(new Error(maskedErrorSummary(outcome.error ?? "")));
    span.end();
  } catch {
    /* 可观测性旁路 */
  }
}

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
   * 未提供时 `runForkedAgent` 自建一份独立 tracker 的有状态工具（F5，2026-10-07）——
   * 缺省值曾是「共享主注册表实例」，即缺省就踩上面那条护栏绕过。
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
  usage: Usage;
  turns: number;
  /** 被 canUseTool 拒绝的工具调用次数 */
  deniedToolCalls: number;
}

/**
 * 收集 forked agent 的工具定义 —— **刻意全量，不按 canUseTool 白名单裁剪**（缺陷 7）。
 *
 * 理由是 prompt cache 经济学，不是「受约束的工具也得声明」：
 * fork 的请求 = 主对话的 system + 全量 messages + 一条追加提示。Anthropic 族的缓存前缀
 * 顺序是 tools → system → messages，**tools 一变整条前缀全 miss**——而 messages
 * 是主会话的全部历史（常见数万 token），远大于被拒工具的 schema 开销。
 * 主循环在 tool search 关闭时发的正是 `registry.definitions()`（query/loop.ts），
 * 与这里逐字节一致，fork 才能读到主会话已写好的缓存。
 *
 * ⛔ 不要「顺手」改成只发白名单工具：省下几 KB schema，换来每次 fork 全价重付整段历史。
 * 被拒工具的调用由 `canUseTool` 兜底（记 `deniedToolCalls`），提示词也明确禁止
 * 为核实而调用工具（见 memory/extract/prompts.ts 的「不要验证」段）。
 * 已知未对齐：主循环开启 tool search 时发 `activeDefinitions()`，此时两者不同、
 * fork 不共享 tools 段缓存 —— 对齐需要把主循环实际发出的定义透传进来，未做。
 * 守卫单测：tests/agent/forked-agent.test.ts「工具定义与主注册表 definitions() 一致」。
 */
export function buildToolDefinitions(registry: ToolRegistry): ToolDefinition[] {
  return registry.definitions();
}

/** 累积一次流式响应 */
async function accumulate(
  stream: AsyncIterable<any>,
  signal?: AbortSignal,
): Promise<{
  content: ContentBlock[];
  stopReason: string | null;
  usage: Usage;
}> {
  const content: ContentBlock[] = [];
  let stopReason: string | null = null;
  // §5.2.2 ③ 顺带修：cache 字段此前**全部丢弃**（只累加 in/out）。
  // 计费已由发生侧负责（llm/billing-sink.ts），所以这个值只用于日志与返回值；
  // 但仍必须带上 cache —— 一个"显示 in/out 却看不到命中"的数字与账本对不上，
  // 而"两个数字都对不上"比"没有数字"更难排查。
  const usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  const partialJson = new Map<number, string>();

  for await (const event of stream) {
    // B3 纵深防御：forked-agent 流消费中检查 signal，防止 abort 无法穿透底层时挂死
    // （对齐 agent/stream-processor.ts 的 B1 模式）
    if (signal?.aborted) {
      return { content: content.filter(Boolean), stopReason: "error", usage };
    }
    switch (event.type) {
      case "message_start": {
        const u = event.message?.usage;
        usage.inputTokens += u?.inputTokens ?? 0;
        // cache 两段一并累加（此前丢弃，见上方 usage 声明处的注释）。
        usage.cacheReadInputTokens =
          (usage.cacheReadInputTokens ?? 0) + (u?.cacheReadInputTokens ?? 0);
        usage.cacheCreationInputTokens =
          (usage.cacheCreationInputTokens ?? 0) + (u?.cacheCreationInputTokens ?? 0);
        break;
      }
      // 流重开 → 上一次尝试的内容块全部作废（2026-08-04 事故根因修复）。
      // 与子代理/无头路径同构（按 index 落位 → 重开后残留高位块）。
      case "stream_restart": {
        const outcome = resetOnStreamRestart({ content, jsonAccumulators: partialJson });
        recordStreamRestart(event, outcome, "forked");
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
          partialJson.set(
            event.index,
            (partialJson.get(event.index) ?? "") + event.delta.partial_json,
          );
        }
        break;
      case "content_block_stop": {
        const block = content[event.index];
        // D8：provider 在 stop 时修订 tool_use 身份（见 StreamEvent.content_block_stop.tool_use）
        if (block?.type === "tool_use" && event.tool_use) {
          block.id = event.tool_use.id;
          block.name = event.tool_use.name;
        }
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
  // 未注入时自建独立 tracker（F5）：缺省不得共享主代理 tracker。只替换主注册表里
  // 确实有的那几个名字 —— 工具定义取自主注册表，不能让 fork 调到一个没声明给模型的工具。
  const statefulMap = new Map<string, LegacyTool>();
  const ownTracker = mainContext.statefulTools ? null : new FileReadTracker();
  const stateful =
    mainContext.statefulTools ??
    createStatefulTools(ownTracker!).filter((t) => mainContext.toolRegistry.get(t.name()));
  for (const t of stateful) {
    statefulMap.set(t.name(), t);
  }
  // F1：自建 tracker 时，bash 也要绑到它——否则 fork 自己 bash 改完文件，回扫刷新的是主代理
  // tracker，fork 紧接的 edit 仍被误判外部修改。注入 statefulTools 的调用方拿不到其 tracker，
  // 那条路径维持复用主 bash（回扫落到主 tracker：对主代理是正确信息，不是污染）。
  const mainBash = mainContext.toolRegistry.get("bash") as
    | (LegacyTool & { withFileReadTracker?: (t: FileReadTracker) => LegacyTool })
    | undefined;
  if (ownTracker && typeof mainBash?.withFileReadTracker === "function") {
    statefulMap.set("bash", mainBash.withFileReadTracker(ownTracker));
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
          // PR2/PR3：给 fork 的流一个**自己的身份**。
          //
          // 不传的后果（实测，本次事故第 3 层）：fork 的流继承主循环最后登记的
          // turnIndex，与主循环共用同一个 attempt 计数器 —— 两个 fork 交替发请求时
          // attempt 单调涨到 8，在轨迹里长得完全就是"一个请求重试了 8 次"。
          // 于是 digest 把它算成 `retryWastedTokens`（重试白烧），**归因指向了错的地方**，
          // 照那个标签排查会走到 fallback 的重试逻辑上，而那里没有问题。
          //
          // 有了 agentId，漏斗会用它建立请求级上下文（见 resilient-stream.ts），
          // provider 侧的计费事件与 StreamPhase 都能归到具体是哪个 fork。
          // querySource 已经带了任务标签（`agent:fork`），这里用它区分两个 fork 实例。
          agentId: `fork:${options.querySource}`,
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
      const toolUses = content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );
      if (toolUses.length === 0 || stopReason === "end_turn") {
        break; // 无工具调用，结束
      }

      // 执行工具（受 canUseTool 约束）
      const results: ContentBlock[] = [];
      for (const tu of toolUses) {
        const decision = await options.canUseTool(tu.name, tu.input);
        if (decision.behavior !== "allow") {
          deniedToolCalls++;
          // 漏斗 2：`deniedToolCalls` 只进返回值与一行日志，出不了聚合口径 ——
          // 调用方拿到它多半就丢了（实测唯一去处是那句 log）。补一条结构化埋点，
          // 让 forked 路径的拒绝与主循环/子代理在同一张表里可比。
          //
          // reasonType 固定 "other"：这条路走的是调用方注入的 `canUseTool` 回调，
          // 拿不到 `PermissionDecisionReason` —— **不猜**。填一个像模像样的
          // "rule" 会让读数的人以为有规则参与，而那是编的。
          //
          // B33：这里**刻意不** fire PermissionDenied hook。forked 的调用方全是内部旁路
          // （记忆提取 / dream / session-memory / `/btw`），拒绝来自调用方注入的工具裁剪，
          // 是设计内行为而非用户的权限策略生效 —— fire 出去会让「权限被拒通知到 IM」
          // 被内部 side-call 刷屏（`/btw` 每次都全拒）。主循环与子代理两条路径已接。
          logPermissionDeny(tu.name, {
            source: "other",
            needsPrompt: false,
            context: "forked",
            reasonType: "other",
          });
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `权限拒绝: ${decision.behavior === "deny" ? decision.message : "工具不可用"}`,
            is_error: true,
          });
          continue;
        }
        // 缺陷 5：allow 与 deny 同口径（reasonType 同样固定 "other"，理由见上方 deny 注释）。
        logPermissionAllow(tu.name, {
          source: "other",
          needsPrompt: false,
          context: "forked",
          reasonType: "other",
        });
        const tool = statefulMap.get(tu.name) ?? mainContext.toolRegistry.get(tu.name);
        // 缺陷 30：漏斗 1 · 工具在 forked 路径上补齐（与子代理同序：权限通过之后才记 call，
        // 拒绝走漏斗 2 不进 tool_call）。filePath 取原始入参，与主循环 / 子代理同字段。
        const forkedFilePath =
          typeof (tu.input as Record<string, unknown> | undefined)?.file_path === "string"
            ? ((tu.input as Record<string, unknown>).file_path as string)
            : undefined;
        const toolStartedAt = Date.now();
        logToolCall(tu.name, forkedFilePath);
        if (!tool) {
          // 工具不存在：模型点了未注册工具，按入参非法计（与 zod 校验失败同属「模型给错了」）
          logToolFailure(tu.name, {
            kind: "invalid_input",
            durationMs: 0,
            filePath: forkedFilePath,
          });
          recordForkedToolSpan(tu.name, tu.id, options.querySource, {
            durationMs: 0,
            isError: true,
            error: `工具不存在: ${tu.name}`,
          });
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
            logToolFailure(tu.name, {
              kind: "invalid_input",
              durationMs: Date.now() - toolStartedAt,
              filePath: forkedFilePath,
            });
            recordForkedToolSpan(tu.name, tu.id, options.querySource, {
              durationMs: Date.now() - toolStartedAt,
              isError: true,
              error: validation.message,
            });
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: validation.message,
              is_error: true,
            });
            continue;
          }
          // 注入 _agentId 标记，防止分叉代理调用 enter_plan_mode 形成套娃
          const res = await tool.execute(
            { ...(validation.data as Record<string, unknown>), _agentId: "forked-agent" },
            signal,
          );
          const elapsed = Date.now() - toolStartedAt;
          if (res.isError) {
            logToolFailure(tu.name, {
              kind: "tool_error",
              durationMs: elapsed,
              filePath: forkedFilePath,
            });
          } else {
            logToolSuccess(tu.name, {
              durationMs: elapsed,
              outputSize: res.output?.length ?? 0,
              filePath: forkedFilePath,
            });
          }
          recordForkedToolSpan(tu.name, tu.id, options.querySource, {
            durationMs: elapsed,
            isError: !!res.isError,
            error: res.isError ? String(res.output ?? "") : undefined,
          });
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: res.output,
            is_error: res.isError,
          });
        } catch (err: any) {
          const elapsed = Date.now() - toolStartedAt;
          // 取消单独分型（同子代理）：它不是「工具不可靠」的证据，混进 exception 会污染失败率
          logToolFailure(tu.name, {
            kind: err?.name === "AbortError" ? "aborted" : "exception",
            durationMs: elapsed,
            filePath: forkedFilePath,
          });
          recordForkedToolSpan(tu.name, tu.id, options.querySource, {
            durationMs: elapsed,
            isError: true,
            error: String(err?.message ?? err),
          });
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
