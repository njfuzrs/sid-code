// src/telemetry/content-tracing.ts
// 内容级 tracing——让 span 携带 prompt / 响应 / 工具输入输出的**真实内容**
//
// 缺陷清单 P1-5：「无内容级 tracing，LLM 决策仍是黑盒」。
// 此前排查「模型这一轮为什么做错了」只能翻 raw.jsonl，而 span 树上一个字的内容都没有。
//
// ⚠️ 这是本仓库里隐私敏感度最高的一条采集通道——它按定义就是要把用户的 prompt、
// 代码片段、工具输出送进 span。所以四道闸门缺一不可，**默认全关**：
//
//   1. 环境变量 SID_CODE_CONTENT_TRACING=1     ——显式开启，不配就是关
//   2. Feature Flag `content_tracing`          ——灰度开关（P1-9 的真实消费者，见下）
//   3. 隐私级别不得为 no-telemetry/essential-traffic
//   4. 全部内容过 maskSensitiveData 脱敏
//
// 第 2 道是刻意与 P1-9 绑在一起的：Feature Flag 系统 205 行长期「除了被初始化一次，
// 没有任何业务代码读取任何 flag」，采样率与 killswitch 是两个永远返回默认值的死开关。
// 缺陷清单 P1-9 的修复要求原文是「至少让一个 flag 真正门控一件事——建议就用它门控
// P1-5 的内容级 tracing 灰度」。这里就是那个真实消费者：**关掉 flag 能真的关掉功能**。
//
// 四个设计点照 claude-code 的 betaSessionTracing.ts 抄，一个都没省（清单原文：
// 「漏掉第 1 点这个功能会因为成本过高而不得不再关掉」）：
//
//   1. **按 hash 去重**：system prompt / 工具 schema 每会话每个唯一值只发一次全文。
//      不做去重的话，一个 30KB 的 system prompt 会在每轮重发——20 轮就是 600KB，
//      成本和带宽都会逼着人把功能关掉。span 上永远带 hash + preview + length，
//      靠 hash 关联到那条只发一次的全文事件。
//   2. **截断上限**：见 MAX_CONTENT_BYTES。
//   3. **独立开关 + 默认关闭**：与常规遥测分开，内容级数据的隐私敏感度完全不同。
//   4. **compact 后清状态**：消息被替换后旧 hash 失效，必须重新发一次全文。
//
// 与 CC 的一处**刻意分歧**：截断按 **UTF-8 字节**而非字符数。CC 用 `content.length`
// （UTF-16 码元数）是因为它面对的主要是英文；本仓库的 prompt 与代码注释大量是中文，
// 一个汉字 3 字节，按字符数算 60K「字符」实际是 180KB——足以撑爆下游的属性大小限制。
// 限制本身是字节限制，就该按字节量。

import { createHash } from "node:crypto";
import type { SpanHandle } from "./bus.ts";
import type { Attributes } from "./types.ts";

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/**
 * 单条内容的字节上限。
 *
 * 60KB 的来由：常见 OTel 后端（Honeycomb 等）单属性上限 64KB，留 4KB 余量给
 * 同一 span 上的其它属性与协议开销。宁可截断也不要整条 span 被后端静默拒收——
 * 「发出去了但对方没收」是最难排查的一类故障。
 */
export const MAX_CONTENT_BYTES = 60 * 1024;

/** system prompt / 响应的 preview 长度（字符数，只为人眼扫一眼，不求精确） */
const PREVIEW_CHARS = 500;

/** 开启内容级 tracing 的环境变量 */
const ENV_SWITCH = "SID_CODE_CONTENT_TRACING";

/**
 * 灰度 flag 名。这是 Feature Flag 系统的第一个真实消费者（P1-9）。
 *
 * 默认值 true 是有讲究的：本地开关（第 1 道闸门）已经默认关闭了整个功能，flag 的职责
 * 不是「再关一次」，而是**远端紧急刹车**——万一内容级 tracing 在某个版本上出问题
 * （发太多、发错内容），运维不发版就能把它关掉。所以默认放行、远端可否决。
 * 与 killswitch 的语义一致。
 */
export const CONTENT_TRACING_FLAG = "content_tracing";

// ─────────────────────────────────────────────────────────────
// 会话内状态
// ─────────────────────────────────────────────────────────────

/**
 * 本会话已发过全文的内容 hash。
 *
 * 存 hash 而非内容本身：一个长会话可能有几十个唯一 system prompt / 工具 schema，
 * 存全文等于把它们在内存里留一份副本。hash 是 12 字符定长。
 */
const seenHashes = new Set<string>();

/**
 * hash 集合上限——防长会话内存无界增长。
 *
 * 超限后**清空重来**而不是拒绝新增：拒绝新增会让后续所有内容都被判成「已发过」从而
 * 永久丢失全文（静默失败）；清空只是让下一轮重发一次全文（多花一点带宽，数据仍完整）。
 * 两害相权取其轻——可观测性通道宁可多发，不可静默丢。
 */
const MAX_SEEN_HASHES = 512;

/**
 * 清空会话内 hash 状态。
 *
 * **必须在 compact 之后调用**（设计点 4）：压缩会把历史消息替换成摘要，此前发过的
 * 内容 hash 与压缩后的上下文再无对应关系。不清的话，压缩后重建的 system prompt
 * 若恰好与旧值同 hash，全文就永远不会再发一次，span 上只剩一个指向已失效事件的 hash。
 */
export function clearContentTracingState(): void {
  seenHashes.clear();
}

/** 已记录的 hash 数（测试用） */
export function getSeenHashCount(): number {
  return seenHashes.size;
}

// ─────────────────────────────────────────────────────────────
// 开关
// ─────────────────────────────────────────────────────────────

/**
 * 内容级 tracing 是否启用——四道闸门全过才算开。
 *
 * 顺序刻意：先判**不需要任何 IO 的**本地开关，绝大多数会话在第一行就返回 false，
 * 不会因为这个功能多读一次 flag 缓存。
 */
export function isContentTracingEnabled(): boolean {
  // 闸门 1：本地显式开关。不配 = 关（默认关闭是硬要求）
  if (process.env[ENV_SWITCH] !== "1") return false;

  // 闸门 3：隐私级别。no-telemetry / essential-traffic 下绝不外发内容。
  // 放在 flag 之前判：隐私是用户的硬约束，不该被远端 flag 影响，也不该为它读缓存。
  try {
    // 同步 require 而非 await import：本函数在每个 span 上被调用，不能是 async。
    const { isTelemetryDisabled } = require("../analytics/privacy-level.ts");
    if (isTelemetryDisabled()) return false;
  } catch {
    // 隐私模块加载不出来时**保守关闭**——判不出隐私级别就不发内容。
    return false;
  }

  // 闸门 2：远端灰度 flag（P1-9 的真实消费者）。默认放行，远端可紧急否决。
  try {
    const { getFeatureValue_CACHED_MAY_BE_STALE } = require("../analytics/feature-flags.ts");
    return getFeatureValue_CACHED_MAY_BE_STALE(CONTENT_TRACING_FLAG, true) === true;
  } catch {
    // flag 系统未初始化（例如 essential-traffic 下根本没初始化）时按本地开关走：
    // 用户已经显式配了 SID_CODE_CONTENT_TRACING=1，不该因为拿不到远端配置而失效。
    return true;
  }
}

// ─────────────────────────────────────────────────────────────
// 内容处理：截断 + 脱敏 + hash
// ─────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/**
 * 按 UTF-8 字节截断，不切坏多字节字符。
 *
 * 实现：先按字节切，再用非 fatal 的 TextDecoder 解码——尾部残缺的多字节序列会变成
 * U+FFFD，把它剥掉即可。比手写「回退到上一个字符边界」短且不会漏 case（BMP 外的
 * emoji 是 4 字节 + 代理对，手写边界判断很容易错）。
 */
export function truncateToBytes(
  content: string,
  maxBytes: number = MAX_CONTENT_BYTES,
): { content: string; truncated: boolean; originalBytes: number } {
  const bytes = encoder.encode(content);
  if (bytes.length <= maxBytes) {
    return { content, truncated: false, originalBytes: bytes.length };
  }
  // 尾部留出截断标记的空间，保证产物总字节数不超过 maxBytes
  const marker = "\n\n[已截断——超出 60KB 上限]";
  const markerBytes = encoder.encode(marker).length;
  const head = decoder.decode(bytes.slice(0, Math.max(0, maxBytes - markerBytes)));
  return {
    content: head.replace(/�+$/, "") + marker,
    truncated: true,
    originalBytes: bytes.length,
  };
}

/** 12 位短 hash（sha256 前 12 个十六进制字符）——碰撞概率在单会话尺度可忽略 */
function shortHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/**
 * 内容外发前的统一处理：**先脱敏，再截断**。
 *
 * 顺序不能反。先截断再脱敏的话，一个横跨截断点的凭证会被切成两半——前半段留在
 * 产物里，而脱敏正则匹配的是完整形态，于是**匹配不上、半个密钥原样发出去**。
 * 先脱敏则无论截在哪里，留下的都是已经打过码的文本。
 */
function prepare(raw: string): { content: string; truncated: boolean; originalBytes: number } {
  let masked = raw;
  try {
    const { maskSensitiveData } = require("../permission/sensitive.ts");
    masked = maskSensitiveData(raw);
  } catch {
    // 脱敏模块不可用时**不外发内容**：宁可少一条诊断数据，不可裸传凭证。
    return { content: "[脱敏模块不可用，内容已丢弃]", truncated: false, originalBytes: 0 };
  }
  return truncateToBytes(masked);
}

/** 安全序列化——循环引用等异常一律降级为占位符，绝不抛到调用方 */
function safeStringify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * 记一条「首次出现的全文」事件；重复内容只返回 hash 不重发全文（设计点 1）。
 *
 * @returns hash（永远返回，供 span 属性关联），以及本次是否发了全文
 */
function emitOnce(
  span: SpanHandle,
  eventName: string,
  content: string,
  extraAttrs: Attributes = {},
): { hash: string; emitted: boolean } {
  const hash = shortHash(content);
  const key = `${eventName}:${hash}`;
  if (seenHashes.has(key)) return { hash, emitted: false };

  if (seenHashes.size >= MAX_SEEN_HASHES) seenHashes.clear();
  seenHashes.add(key);

  const { content: body, truncated, originalBytes } = prepare(content);
  span.addEvent(eventName, {
    content_hash: hash,
    content: body,
    content_bytes: originalBytes,
    ...(truncated ? { content_truncated: true } : {}),
    ...extraAttrs,
  });
  return { hash, emitted: true };
}

// ─────────────────────────────────────────────────────────────
// 对外：三个挂载点
// ─────────────────────────────────────────────────────────────

/**
 * chat span 的请求侧内容：system prompt + 工具 schema + 本轮新增消息。
 *
 * 「本轮新增」而非全量历史：全量历史在每轮都重发一遍，20 轮的会话会把同一条早期
 * 消息发 20 次。这里只发**增量**（本轮相对上一轮多出来的消息），span 上带
 * message_count 说明总量。这与 CC 的 lastReportedMessageHash 思路相同，但实现更简单：
 * 我们直接按每条消息各自 hash 去重，天然拿到增量，不需要额外维护「上次报到哪」的指针
 * ——后者在多 agent（主循环 / 子代理）并存时还要按 querySource 分桶，容易错。
 */
export function addRequestContent(
  span: SpanHandle,
  payload: { system?: unknown; tools?: unknown[]; messages?: unknown[] },
): void {
  if (!isContentTracingEnabled()) return;
  try {
    // ── system prompt ──
    const system = safeStringify(payload.system);
    if (system) {
      const { hash } = emitOnce(span, "content.system_prompt", system);
      span.setAttributes({
        "sidcode.content.system_prompt_hash": hash,
        "sidcode.content.system_prompt_preview": system.slice(0, PREVIEW_CHARS),
        "sidcode.content.system_prompt_bytes": encoder.encode(system).length,
      });
    }

    // ── 工具 schema ──
    // 逐个工具各自 hash：工具列表整体 hash 会因为「多了一个 MCP 工具」而整体失效，
    // 把几十个没变的 schema 全部重发一遍。按单个工具去重才真正省。
    if (Array.isArray(payload.tools) && payload.tools.length > 0) {
      const digest: string[] = [];
      for (const tool of payload.tools) {
        const json = safeStringify(tool);
        if (!json) continue;
        const name = (tool as { name?: unknown })?.name;
        const toolName = typeof name === "string" ? name : "unknown";
        const { hash } = emitOnce(span, "content.tool_schema", json, {
          // 工具名过脱敏门面同一套规则：MCP 工具名含用户私有服务名
          tool_name: sanitizedToolName(toolName),
        });
        digest.push(`${sanitizedToolName(toolName)}:${hash}`);
      }
      span.setAttributes({
        "sidcode.content.tools_count": payload.tools.length,
        "sidcode.content.tools_digest": digest.join(","),
      });
    }

    // ── 本轮消息（增量）──
    if (Array.isArray(payload.messages) && payload.messages.length > 0) {
      let newCount = 0;
      const parts: string[] = [];
      for (const msg of payload.messages) {
        const json = safeStringify(msg);
        if (!json) continue;
        const hash = shortHash(json);
        const key = `content.message:${hash}`;
        if (seenHashes.has(key)) continue;
        if (seenHashes.size >= MAX_SEEN_HASHES) seenHashes.clear();
        seenHashes.add(key);
        newCount++;
        parts.push(json);
      }
      if (parts.length > 0) {
        const joined = parts.join("\n---\n");
        const { content, truncated, originalBytes } = prepare(joined);
        span.addEvent("content.new_messages", {
          content,
          content_bytes: originalBytes,
          message_count: newCount,
          ...(truncated ? { content_truncated: true } : {}),
        });
      }
      span.setAttributes({
        "sidcode.content.messages_total": payload.messages.length,
        "sidcode.content.messages_new": newCount,
      });
    }
  } catch {
    // 内容级 tracing 是纯旁路，任何异常都不许影响 LLM 主流程
  }
}

/**
 * chat span 的响应侧内容：模型输出文本 + thinking。
 *
 * thinking 与正文分开两个属性：thinking 是模型的推理过程，隐私与体量特征都和正文
 * 不同（往往长得多），下游需要能单独取用或单独丢弃。
 */
export function addResponseContent(
  span: SpanHandle,
  payload: { text?: string; thinkingBlocks?: unknown[] },
): void {
  if (!isContentTracingEnabled()) return;
  try {
    if (typeof payload.text === "string" && payload.text.length > 0) {
      const { content, truncated, originalBytes } = prepare(payload.text);
      span.addEvent("content.model_output", {
        content,
        content_bytes: originalBytes,
        ...(truncated ? { content_truncated: true } : {}),
      });
      span.setAttributes({
        "sidcode.content.output_preview": payload.text.slice(0, PREVIEW_CHARS),
        "sidcode.content.output_bytes": originalBytes,
      });
    }

    const thinking = Array.isArray(payload.thinkingBlocks)
      ? safeStringify(payload.thinkingBlocks)
      : undefined;
    if (thinking) {
      const { content, truncated, originalBytes } = prepare(thinking);
      span.addEvent("content.thinking_output", {
        content,
        content_bytes: originalBytes,
        ...(truncated ? { content_truncated: true } : {}),
      });
      span.setAttribute("sidcode.content.thinking_bytes", originalBytes);
    }
  } catch {
    // 旁路
  }
}

/**
 * execute_tool span 的内容：工具入参 + 返回值。
 *
 * 这两样是「模型这一步为什么做错了」最直接的证据——模型给了什么参数、工具回了什么。
 * 不去重：每次工具调用的入参与结果都是独立事实，重复的调用本身就是要看的现象
 * （同一个 Read 连读 5 次说明模型在原地打转）。
 */
export function addToolContent(
  span: SpanHandle,
  payload: { toolInput?: unknown; toolResponse?: unknown },
): void {
  if (!isContentTracingEnabled()) return;
  try {
    const input = safeStringify(payload.toolInput);
    if (input) {
      const { content, truncated, originalBytes } = prepare(input);
      span.addEvent("content.tool_input", {
        content,
        content_bytes: originalBytes,
        ...(truncated ? { content_truncated: true } : {}),
      });
    }
    const response = safeStringify(payload.toolResponse);
    if (response) {
      const { content, truncated, originalBytes } = prepare(response);
      span.addEvent("content.tool_result", {
        content,
        content_bytes: originalBytes,
        ...(truncated ? { content_truncated: true } : {}),
      });
    }
  } catch {
    // 旁路
  }
}

/** 复用埋点门面的工具名脱敏规则，拿不到时退化为「只保留是否 MCP」这一位信息 */
function sanitizedToolName(name: string): string {
  try {
    const { sanitizeToolName } = require("../analytics/sanitize.ts");
    return sanitizeToolName(name);
  } catch {
    return name.startsWith("mcp__") ? "mcp_tool" : name;
  }
}
