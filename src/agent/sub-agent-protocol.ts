/**
 * 子代理进程间通信协议
 *
 * Wave 2 (Spawn 模式)：父进程通过 Bun.spawn 启动子进程，
 * 通过 stdin/stdout JSON Line 通信。
 *
 *   父 → 子 (stdin):  init / tool_result / signal
 *   子 → 父 (stdout): ready / tool_use / progress / result / crash
 *
 * 设计原则：
 * - 每条消息是一行完整 JSON（NDJSON），以 \n 分隔
 * - API Key 只在管道中传输，不出现在 ps / 文件系统
 * - 子进程只跑 LLM 循环，工具执行回传父进程
 */

import type { Usage } from "../llm/types.ts";

// ============================================================
// 父 → 子 (stdin)
// ============================================================

/** 工具定义（子进程需要传给 LLM） */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * 是否启用 Constrained Decoding（模型保证 100% JSON 合规）。
   * 由父进程经 `registry.definitionsForTools()` 正路径派生（与进程内路径同源），
   * 子进程透传给 provider。此前手写映射丢此字段（审计第 18 条）。
   */
  strict?: boolean;
}

/** 初始化消息：父进程启动子进程后立即发送 */
export interface ParentInitMessage {
  type: "init";
  session_id: string;
  /** 子代理类型（内置联合类型 or 动态注册的自定义/插件 agent 类型名） */
  task_type: string;
  system_prompt: string;
  user_prompt: string;
  /** 工具名列表（日志用） */
  allowed_tools: string[];
  /** 工具定义（子进程传给 LLM 用） */
  tool_defs: ToolDef[];
  /** 模型**本地别名**（availableModels[].name）。日志/归因用；发线上的真名见 wire_model */
  model: string;
  /**
   * 发往厂商的**真实模型 id**（wire model）。缺省时子进程按 model 原样发。
   *
   * 为什么必须跨进程传：spawn 出的子代理是**独立 OS 进程**，它不读 settings.json、
   * 不跑 loadConfig，因此 llm/wire-model.ts 的进程级别名表在子进程里恒为空 ——
   * 只传 model（别名）会让子代理把 "xxx-gateway" 当模型名发给厂商吃 400/404，
   * 而父进程一切正常，故障只在「子代理 + 配了 model_id」这一格里出现，极难归因。
   * 父进程已解析好真名，直接随 init 传过来是最省的做法（无需把整份 availableModels 过管道）。
   */
  wire_model?: string;
  max_turns: number;
  max_tokens: number;
  timeout: number;
  workdir: string;
  /** Provider 类型："anthropic" | "openai" | "ollama" */
  provider_name: string;
  /** ⚠️ API Key — 只在管道中传输 */
  api_key: string;
  base_url?: string;
}

/** 工具执行结果：父进程执行工具后发送 */
export interface ParentToolResultMessage {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

/** 控制信号 */
export interface ParentSignalMessage {
  type: "signal";
  signal: "abort";
}

export type ParentMessage =
  | ParentInitMessage
  | ParentToolResultMessage
  | ParentSignalMessage;

// ============================================================
// 子 → 父 (stdout)
// ============================================================

/** 子进程就绪 */
export interface ChildReadyMessage {
  type: "ready";
}

/** 子进程需要执行工具（回传父进程） */
export interface ChildToolUseMessage {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** 进度报告（用于长时间任务的实时进度面板） */
export interface ChildProgressMessage {
  type: "progress";
  turn: number;
  max_turns: number;
  /** 截至本轮的累计工具调用次数 */
  toolUseCount?: number;
  /** 截至本轮的累计真实 token 数（input + output） */
  tokenCount?: number;
  /** 本轮最后一次工具调用的简短活动文案（如「读取 src/foo.ts」） */
  lastActivity?: string;
}

/** 子代理执行结果 */
export interface ChildResultMessage {
  type: "result";
  success: boolean;
  output: string;
  usage: Usage;
  turns: number;
  /** 工具调用次数（用于构造结构化 AgentTaskResult） */
  toolUseCount: number;
  /** 子代理实际使用的模型名（P0-1：归集计费时按此 model 分别计价） */
  model?: string;
  /** 子代理实际使用的 provider 名（计费口径区分） */
  provider?: string;
}

/** 子进程崩溃消息 */
export interface ChildCrashMessage {
  type: "crash";
  error: string;
  stack?: string;
}

export type ChildMessage =
  | ChildReadyMessage
  | ChildToolUseMessage
  | ChildProgressMessage
  | ChildResultMessage
  | ChildCrashMessage;

// ============================================================
// 辅助函数
// ============================================================

/** 父进程写消息到子进程 stdin */
export function writeParentMsg(
  writer: { write(data: Uint8Array): number },
  msg: ParentMessage,
): void {
  const line = JSON.stringify(msg) + "\n";
  writer.write(Buffer.from(line));
}

/** 子进程写消息到 stdout */
export function writeChildMsg(msg: ChildMessage): void {
  const line = JSON.stringify(msg) + "\n";
  process.stdout.write(line);
}

/**
 * 从 ReadableStream 读取一行（以 \n 分隔）。
 * 返回 null 表示流已结束且无数据。
 */
export async function readLineFromStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buffer: { value: string },
): Promise<string | null> {
  // 如果 buffer 中已有完整行，直接返回
  const newlineIdx = buffer.value.indexOf("\n");
  if (newlineIdx >= 0) {
    const line = buffer.value.slice(0, newlineIdx);
    buffer.value = buffer.value.slice(newlineIdx + 1);
    return line;
  }

  // 从流中读取更多数据
  const { done, value } = await reader.read();
  if (done) {
    // 流结束，返回 buffer 残余（如有）
    const remaining = buffer.value.trim();
    buffer.value = "";
    return remaining || null;
  }

  buffer.value += decoder.decode(value, { stream: true });

  // 再次检查是否有完整行
  const idx = buffer.value.indexOf("\n");
  if (idx >= 0) {
    const line = buffer.value.slice(0, idx);
    buffer.value = buffer.value.slice(idx + 1);
    return line;
  }

  // 还没有完整行，继续递归读取
  return readLineFromStream(reader, decoder, buffer);
}
