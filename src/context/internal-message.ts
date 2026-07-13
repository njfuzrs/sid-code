/**
 * 内部消息来源标记 —— 单一事实源 + 统一构造器
 *
 * ## 背景
 *
 * agent 系统会往消息序列里注入"仅供 LLM、不该在 TUI 渲染"的内部消息对：
 * 压缩摘要 + ack、会话恢复摘要 + ack、压缩后重注入的文件/Plan/决策锚点、后台任务通知等。
 * 这些消息发给模型维持上下文，但既非真实用户输入、也非模型真实答复，泄漏到 TUI 会让用户
 * 看到「> [对话摘要]…」和凭空的「好的，我已了解」。
 *
 * ## 为什么用结构化 `_meta.origin` 而非文本前缀
 *
 * 历史上靠 `isInternalOnlyText` 前缀匹配（`<system-reminder>` / `[压缩边界]` 等）识别，但：
 *  - 前缀匹配脆弱：文案微调一次就失配，泄漏复发（"发现一处补一处"）。
 *  - 前缀匹配**只能覆盖 user 侧文本**，无法覆盖 assistant 侧固定 ack（ack 是正常中文句子，
 *    没有可匹配的前缀特征）。
 *
 * 对标 claude-code：cc 用单一结构化布尔字段 `isMeta` + 单一渲染谓词 `shouldShowUserMessage`
 * 决定可见性，`<system-reminder>` 文本标签只是给模型看的内容约定、不参与可见性判断。本模块
 * 把同一思路落到 `_meta.origin`：**可见性由结构化字段决定，不解析消息文本**。
 *
 * ## 单一事实源
 *
 * `INTERNAL_ORIGINS` 是内部来源的**唯一登记表**。新增任何"内部注入消息对"必须：
 *  1. 在此登记来源常量；
 *  2. 用 `markInternal` / `buildInternalMessage` 构造（自动打 `_meta.origin`）。
 *
 * 哨兵测试（tests/context/internal-message-sentinel.test.ts）会扫描已知注入点，
 * 断言注入的固定文案 assistant ack 都带已登记的 origin，未登记即测试失败——把"防泄漏"
 * 从"开发者自觉"变成"机制强制 + 测试兜底"。对标本项目 `ABORT_REASONS` 防漂移哨兵套路。
 */

import type { Message, ContentBlock } from "../llm/types.ts";
import { REATTACH_ORIGIN } from "../query/compact/reattach-markers.ts";

/**
 * 内部消息来源白名单（单一事实源）—— **整条隐藏**语义。
 *
 * 带这些 origin 的消息在 TUI/历史层整条隐藏（见 ui/history-adapter.ts 的 isHiddenFromDisplay）。
 * 顺序无关，值必须与各注入点写入的字符串逐字节一致。
 *
 * ⚠️ 边界：只登记「该整条隐藏」的来源。另有一类内部 origin（task-notification 后台任务通知、
 * command-expansion 斜杠命令展开）虽也带 _meta.origin 标记，但它们走**专用渲染分流**
 * （折叠项 / 只显命令名），**不是整条隐藏**——那些由 history-adapter 自己按 origin 分流处理，
 * 不在此白名单，否则会被 isHiddenFromDisplay 误吞导致渲染丢失。见 INTERNAL_RENDER_ORIGINS。
 */
export const INTERNAL_ORIGINS = [
  /** compactWithSummary / snipCompact / contextCollapse / emergencyTruncate 注入的摘要 + ack */
  "compact-summary",
  /** restoreSession 有摘要路径注入的恢复提示 + ack */
  "resume-summary",
  /** 压缩后重注入的文件正文 / Plan / 决策 / 原始任务锚点 + 各自 ack（= "compact-reattach"） */
  REATTACH_ORIGIN,
] as const;

/**
 * 走**专用渲染分流**的内部 origin（非整条隐藏）。登记于此仅为让"哪些是内部 origin"
 * 有统一事实源、供哨兵测试识别为"已知内部来源"，不参与 isHiddenFromDisplay 的整条隐藏判定。
 */
export const INTERNAL_RENDER_ORIGINS = [
  /** 后台子代理任务完成通知（<task-notification>）→ 折叠项渲染 */
  "task-notification",
  /** 斜杠命令展开 → 只显示触发命令本身，提示词正文不进 TUI */
  "command-expansion",
] as const;

/** 内部消息来源类型（含整条隐藏 + 专用渲染两类，从单一事实源派生）。 */
export type InternalOrigin =
  | (typeof INTERNAL_ORIGINS)[number]
  | (typeof INTERNAL_RENDER_ORIGINS)[number];

/** 整条隐藏判定用的 Set（仅 INTERNAL_ORIGINS）。 */
const HIDE_ORIGIN_SET: ReadonlySet<string> = new Set(INTERNAL_ORIGINS);
/** "是否已知内部来源"判定用的 Set（两类都算，供哨兵测试与统一识别）。 */
const ALL_INTERNAL_ORIGIN_SET: ReadonlySet<string> = new Set([
  ...INTERNAL_ORIGINS,
  ...INTERNAL_RENDER_ORIGINS,
]);

/** 某字符串是否为已登记的内部来源（含整条隐藏 + 专用渲染两类）。 */
export function isInternalOrigin(origin: unknown): origin is InternalOrigin {
  return typeof origin === "string" && ALL_INTERNAL_ORIGIN_SET.has(origin);
}

/**
 * 消息是否带「该整条隐藏」的内部来源标记。
 * 注意：只认 INTERNAL_ORIGINS（整条隐藏类）——task-notification/command-expansion 走专用
 * 渲染分流，不在此返回 true，否则会被 isHiddenFromDisplay 误吞。
 */
export function hasInternalOrigin(msg: Pick<Message, "_meta">): boolean {
  const origin = msg._meta?.origin;
  return typeof origin === "string" && HIDE_ORIGIN_SET.has(origin);
}

/**
 * 给已有消息打内部来源标记（保留原有 _meta 其它字段）。
 *
 * 用于"消息已构造、事后补标记"的场景。返回新对象（不原地改）。
 */
export function markInternal<T extends Message>(msg: T, origin: InternalOrigin): T {
  return {
    ...msg,
    _meta: { ...msg._meta, origin },
  };
}

/**
 * 统一构造一条内部消息（自动打 `_meta.origin`）。
 *
 * 所有新增的内部注入消息对**应**经此构造，而非手写 `_meta: { origin: "…" }`——
 * 手写字面量散落多文件是漂移温床（哨兵测试会拦截未登记的 origin）。
 *
 * @param origin 必须是 INTERNAL_ORIGINS 中登记的来源（类型受 InternalOrigin 约束）
 * @param role   user / assistant
 * @param content 文本字符串（自动包成单个 text block）或完整 ContentBlock[]
 * @param extraMeta 需要合并进 _meta 的其它字段（如 isMeta: true）
 */
export function buildInternalMessage(
  origin: InternalOrigin,
  role: "user" | "assistant",
  content: string | ContentBlock[],
  extraMeta?: Record<string, unknown>,
): Message {
  return {
    role,
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    _meta: { ...extraMeta, origin },
  };
}
