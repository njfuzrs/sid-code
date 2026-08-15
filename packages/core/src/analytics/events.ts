// src/analytics/events.ts
// 埋点门面层——所有产品埋点的唯一入口
//
// 存在的理由（这不是一层可选的糖，是这批修复的地基）：
//
// 本仓库曾长期只有 1 个产品埋点（app.ts 的 startup_timing），而 `sanitize.ts` 三个
// 脱敏函数、`privacy.ts` 的「提取/检测」两半全部零消费者。也就是说，脱敏能力是**写好了
// 但没有任何埋点在用**。如果直接在业务代码里散落 `logEvent("tool_call", { tool_name: ... })`，
// 工具名与文件路径会**裸传**出去——MCP 工具名含用户私有服务名，文件路径含用户目录结构。
//
// 所以补埋点与接脱敏必须同一批做（缺陷清单「批次 A 不可拆」）。做法是：**不让业务代码
// 直接碰 logEvent**，一律走本文件的 emit 函数，脱敏在这里强制发生，业务侧无从绕过。
// 门禁测试（tests/analytics/instrumentation-sentinel.test.ts）会静态扫描并拦住绕过行为。
//
// 三条硬约束，改本文件前先读：
//
// 1. **工具名一律过 sanitizeToolName**：MCP 工具 → "mcp_tool"，真实 server/tool 名只以
//    `_PROTECTED_*` 字段进特权后端。非特权后端（远程监控）看到的永远是脱敏版。
// 2. **文件路径只出扩展名**：走 safeFileExtension，绝不出全路径。路径本身即 PII。
// 3. **不放开 EventMetadataValue 的类型约束**：它故意不允许裸 string，字符串必须显式
//    标记 VerifiedNotCodeOrFilepaths / VerifiedPIITagged。这比 claude-code 更严，是真优势——
//    补埋点时为省事把它放开（改成 `Record<string, any>`）等于把这批修复的意义抹掉。
//
// 事件名集中在 EVENT_NAMES 常量表，供门禁测试双向对账（表里的名字必须有调用点，
// 调用点用的名字必须在表里），防止再退化成「有代码无调用」的死资产。

import { logEvent } from "./index.ts";
import type { EventMetadata, EventMetadataValue, VerifiedNotCodeOrFilepaths } from "./index.ts";
import { PROTECTED_PREFIX } from "./privacy.ts";
import { asVerified } from "./types.ts";
import { sanitizeToolName, safeFileExtension, mcpToolDetailsForAnalytics } from "./sanitize.ts";

// ─────────────────────────────────────────────────────────────
// 事件名单一事实源
// ─────────────────────────────────────────────────────────────

/**
 * 五条核心漏斗的事件名。缺陷清单 P0-1 要求「不要抄 1119 个事件名，先覆盖 5 条核心漏斗，
 * 每条都要能回答一个已经想问但目前答不出的问题」。每个名字后面注明它服务的那个问题。
 */
export const EVENT_NAMES = {
  // ── 漏斗 1 · 工具：哪个工具最不可靠 ──
  TOOL_CALL: "tool_call",
  TOOL_SUCCESS: "tool_success",
  TOOL_FAILURE: "tool_failure",

  // ── 漏斗 2 · 权限：HITL 打扰了多少次（服务「更安全 ↔ 更快」的 trade-off 判断）──
  PERMISSION_PROMPT: "permission_prompt",
  PERMISSION_ALLOW: "permission_allow",
  PERMISSION_DENY: "permission_deny",

  // ── 漏斗 3 · 上下文：「更省」的效果 ──
  CONTEXT_COMPACT: "context_compact",
  CONTEXT_COMPACT_SKIPPED: "context_compact_skipped",

  // ── 漏斗 4 · 命令：哪些功能是死功能 ──
  COMMAND_INVOKE: "command_invoke",
  COMMAND_REJECTED: "command_rejected",

  // ── 漏斗 5 · 错误：哪类错误最高频 ──
  ERROR_OCCURRED: "error_occurred",
} as const;

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

// ─────────────────────────────────────────────────────────────
// 内部：脱敏字段构造
// ─────────────────────────────────────────────────────────────

/**
 * 标记为「已确认不含代码/文件路径」。仅供本文件内部在脱敏之后使用。
 *
 * 委托给 types.ts 的 asVerified：该函数原本零调用点，而本文件与 metadata.ts 各自
 * 手写了一份一模一样的 cast。同一个语义契约有三份实现，改其中一处不会波及另两处。
 */
function v(s: string): VerifiedNotCodeOrFilepaths {
  return asVerified(s);
}

/**
 * 工具名字段构造——强制脱敏。
 *
 * 产出两类字段：
 *   - `tool_name`：脱敏版（MCP → "mcp_tool"），所有后端可见
 *   - `_PROTECTED_mcp_*`：真实 server / tool 名，仅特权后端可见
 *
 * 业务侧拿不到「不脱敏地记一个工具名」的接口，这是刻意的。
 */
export function toolNameFields(toolName: string): EventMetadata {
  const fields: EventMetadata = {
    tool_name: v(sanitizeToolName(toolName)),
    tool_is_mcp: toolName.startsWith("mcp__"),
  };
  // MCP 明细走 _PROTECTED_ 双通道：非特权后端看不到用户的私有服务名
  const details = mcpToolDetailsForAnalytics(toolName);
  for (const key in details) {
    // details 的值已由 sanitize 层保证是纯名字（非路径/代码），此处标记后进 _PROTECTED_ 通道
    fields[key] = v(details[key]!);
  }
  return fields;
}

/**
 * 文件路径字段构造——只出扩展名，绝不出路径本身。
 *
 * 路径含用户目录结构（`/Users/<name>/work/<client>/…`），本身就是 PII。
 * 缺陷清单 P1-6 点明：补埋点时不接这层，等于「把工具名和路径裸传出去」。
 */
export function filePathFields(filePath: string | undefined): EventMetadata {
  if (typeof filePath !== "string" || filePath.length === 0) return {};
  return { file_ext: v(safeFileExtension(filePath)) };
}

/** 把任意值安全地转成 EventMetadataValue（字符串一律先标记）。不抛。 */
function safeValue(value: unknown): EventMetadataValue {
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return v(value);
  return undefined;
}

/**
 * 合并额外字段。调用方传入的字符串值必须**已经是脱敏后的枚举型标签**
 * （如 "user" / "timeout" / "rate_limit"），不是自由文本。
 */
function withExtra(base: EventMetadata, extra?: Record<string, unknown>): EventMetadata {
  if (!extra) return base;
  const out: EventMetadata = { ...base };
  for (const key in extra) {
    const val = safeValue(extra[key]);
    if (val !== undefined) out[key] = val;
  }
  return out;
}

/** 统一出口。logEvent 自身永不抛，此处再兜一层，确保埋点绝不影响主流程。 */
function emit(name: EventName, metadata: EventMetadata): void {
  try {
    logEvent(name, metadata);
  } catch {
    // 遥测是旁路
  }
}

// ─────────────────────────────────────────────────────────────
// 漏斗 1 · 工具
// ─────────────────────────────────────────────────────────────

/** 工具开始执行。与 tool_success / tool_failure 配对，差值即「执行中丢失」的量。 */
export function logToolCall(toolName: string, filePath?: string): void {
  emit(EVENT_NAMES.TOOL_CALL, {
    ...toolNameFields(toolName),
    ...filePathFields(filePath),
  });
}

/** 工具执行成功。带耗时与输出规模，供「哪个工具慢 / 输出大」分析。 */
export function logToolSuccess(
  toolName: string,
  opts: { durationMs: number; outputSize?: number; filePath?: string },
): void {
  emit(EVENT_NAMES.TOOL_SUCCESS, {
    ...toolNameFields(toolName),
    ...filePathFields(opts.filePath),
    duration_ms: opts.durationMs,
    ...(opts.outputSize !== undefined ? { output_size: opts.outputSize } : {}),
  });
}

/**
 * 工具失败分型。
 *
 * `kind` 是**结构化枚举**，由调用点按自己所处的分支直接给出，不做事后猜测。
 * 这是刻意的：记忆里「归因与真实信号脱节反模式」的判据优先级是
 * 「状态码 / reason 白名单 > 数字边界 > 裸子串」——而调用点自己知道它是
 * hook 阻止还是 zod 校验失败，这是比任何字符串匹配都强的信号，白扔掉才是错。
 */
export type ToolFailureKind =
  | "hook_blocked" // PreToolUse hook 阻止
  | "invalid_input" // zod 参数校验失败（含模型漏字段）
  | "permission_denied" // 权限层拒绝
  | "aborted" // 用户取消 / 内部超时
  | "exception" // 工具内部抛异常
  | "tool_error"; // 工具正常返回但 isError=true

export function logToolFailure(
  toolName: string,
  opts: {
    kind: ToolFailureKind;
    durationMs: number;
    filePath?: string;
    /** 结构化错误码（如 ENOENT / HTTP 状态码），不是错误文本 */
    errorCode?: string;
  },
): void {
  emit(EVENT_NAMES.TOOL_FAILURE, {
    ...toolNameFields(toolName),
    ...filePathFields(opts.filePath),
    failure_kind: v(opts.kind),
    duration_ms: opts.durationMs,
    ...(opts.errorCode ? { error_code: v(opts.errorCode) } : {}),
  });
}

// ─────────────────────────────────────────────────────────────
// 漏斗 2 · 权限
// ─────────────────────────────────────────────────────────────

/**
 * 弹出权限确认。这条直接服务北极星里「更安全 ↔ 更快」的 trade-off 判断：
 * 没有它就只能凭感觉争论「HITL 是不是太吵」。
 *
 * ⚠️ **本事件仅在「权限层判定 needsConfirmation=true，即真的要弹窗问用户」时触发；
 * 开发机长期为 0 属正常，不是接线缺陷**（P1-6 分诊结论，勿重复分诊）。
 *
 * 判 a 类（路径本机没走到）的证据，三条互相独立：
 *  1. 唯一调用点 `query/tool-executor.ts` 的 `resolveToolPermission`
 *     在 `if (decision.needsConfirmation)` 分支内 —— 与它**同一个函数**里的
 *     `logPermissionAllow` / `logPermissionDeny` 已落盘 758 / 6 条，
 *     证明函数本身跑过，只是这个分支没进；
 *  2. 落盘的 758 条 `permission_allow` **全部**是 `source:"rule"` +
 *     `needed_prompt:false`，6 条 `permission_deny` 也全是 `needsPrompt:false`——
 *     即每一次鉴权都在 `decision.allowed` / 规则直拒处就短路了；
 *  3. 本机会话跑在允许直放的权限档上（`skipPermissions` 早退 / 规则命中 /
 *     非交互模式直拒），`needsConfirmation` 分支结构上到不了。
 *
 * 推论：要让它出数，得在**交互式**会话里制造一次真需要确认的操作
 * （如未在白名单内的写入），而不是去改这里的接线。
 */
export function logPermissionPrompt(toolName: string): void {
  emit(EVENT_NAMES.PERMISSION_PROMPT, toolNameFields(toolName));
}

/** 权限决策来源。三路竞争（hook / classifier / 用户）各自的胜出比例是真实需要的数。 */
export type PermissionSource = "user" | "hook" | "classifier" | "timeout" | "rule" | "other";

/** 权限批准。needsPrompt 区分「弹过窗才批」与「规则直接放行」。 */
export function logPermissionAllow(
  toolName: string,
  opts: { source: PermissionSource; needsPrompt: boolean; durationMs?: number },
): void {
  emit(EVENT_NAMES.PERMISSION_ALLOW, {
    ...toolNameFields(toolName),
    source: v(opts.source),
    needed_prompt: opts.needsPrompt,
    ...(opts.durationMs !== undefined ? { duration_ms: opts.durationMs } : {}),
  });
}

/** 权限拒绝。durationMs 含「等用户确认」的墙钟——ask 路径可达数十秒，正是要看的那个数。 */
export function logPermissionDeny(
  toolName: string,
  opts: { source: PermissionSource; needsPrompt: boolean; durationMs?: number },
): void {
  emit(EVENT_NAMES.PERMISSION_DENY, {
    ...toolNameFields(toolName),
    source: v(opts.source),
    needed_prompt: opts.needsPrompt,
    ...(opts.durationMs !== undefined ? { duration_ms: opts.durationMs } : {}),
  });
}

// ─────────────────────────────────────────────────────────────
// 漏斗 3 · 上下文（「更省」的效果）
// ─────────────────────────────────────────────────────────────

/** compact 结果分型。与 AutoCompactOutcome 对齐，另加 failed（摘要调用失败降级）。 */
export type CompactOutcome = "summarized" | "truncated" | "failed";

/**
 * 压缩完成。tokensBefore/After 是「更省」这条北极星唯一能直接量出来的信号之一。
 *
 * P1-6 分诊结论：本事件曾判 **b 类（调用点在死路径 / 有一档零 producer）并已修**。
 * 原状是 4 个调用点全在 `query/auto-compact.ts` 且**全部硬编码 `trigger:"auto"`**，
 * 手动 `/compact` 走的是另一条链路（`cli/src/command/commands/compact/compact.ts`
 * 的 partialCompact），真压缩了却一条埋点都不发 —— `trigger:"manual"` 这一档
 * 生产侧零 producer。现已在手动路径补齐 3 个 outcome（summarized/failed×2）。
 *
 * 两条改的时候别破坏的口径约束：
 *  1. `tokensAfter` 必须在 post-compact 收尾**之后**取（收尾会做文件重注入，
 *     那部分 token 也算压缩后的真实占用）。收尾前取会系统性把「省了多少」算多。
 *  2. 摘要链路失败后的有损降级一律记 `failed`，不是 `truncated`——
 *     `truncated` 专留给熔断降级。两条路径必须同口径，否则聚合时要先做换算。
 */
export function logContextCompact(opts: {
  outcome: CompactOutcome;
  trigger: "auto" | "manual";
  messagesBefore: number;
  tokensBefore: number;
  tokensAfter?: number;
  durationMs?: number;
}): void {
  emit(EVENT_NAMES.CONTEXT_COMPACT, {
    outcome: v(opts.outcome),
    trigger: v(opts.trigger),
    messages_before: opts.messagesBefore,
    tokens_before: opts.tokensBefore,
    ...(opts.tokensAfter !== undefined ? { tokens_after: opts.tokensAfter } : {}),
    ...(opts.durationMs !== undefined ? { duration_ms: opts.durationMs } : {}),
  });
}

/**
 * compact 被跳过的原因分型。「触发了但没压成」和「没触发」是两回事，混在一起就看不出问题。
 *
 * ⚠️ `circuit_open` **是这张表里唯一没有 producer 的取值**：`auto-compact.ts` 的
 * `!circuitBreaker.canExecute()` 分支并不 skip，而是降级为简单截断后上报
 * `logContextCompact({ outcome: "truncated" })`（那更准确 —— 它确实压了）。
 * 留着这个取值只为表达「熔断」这个语义档位；**别看到它零命中就去补一个 skip 调用**，
 * 那会让同一次熔断同时记进 compact 与 skipped 两个计数，分母直接被污染。
 */
export type CompactSkipReason = "too_few_messages" | "lock_held" | "hook_blocked" | "circuit_open";

/**
 * P1-6 分诊结论：本事件曾判 **b 类并已修**。原状 3 个调用点全在
 * `query/auto-compact.ts`（auto 路径），手动 `/compact` 的三个同构早退分支
 * （消息太少 / 锁被占 / hook 阻止）**一个都没上报**。现已在
 * `cli/src/command/commands/compact/compact.ts` 补齐同名三档，两条路径同口径。
 */
export function logContextCompactSkipped(reason: CompactSkipReason): void {
  emit(EVENT_NAMES.CONTEXT_COMPACT_SKIPPED, { reason: v(reason) });
}

// ─────────────────────────────────────────────────────────────
// 漏斗 4 · 命令（哪些功能是死功能）
// ─────────────────────────────────────────────────────────────

/**
 * 斜杠命令被调用。
 *
 * 命令名**不脱敏**是有意的，且安全：内置命令名是固定枚举（/model、/compact…），
 * 不含用户数据。但自定义命令与 skill 命令的名字由用户定义，**可能**含项目/客户名——
 * 故 isBuiltin=false 时只上报占位名，真名进 _PROTECTED_ 通道。
 */
export function logCommandInvoke(opts: {
  commandName: string;
  isBuiltin: boolean;
  commandType: "local" | "local-jsx" | "prompt";
  hasArgs: boolean;
}): void {
  const meta: EventMetadata = {
    command_type: v(opts.commandType),
    command_is_builtin: opts.isBuiltin,
    has_args: opts.hasArgs,
  };
  if (opts.isBuiltin) {
    meta.command_name = v(opts.commandName);
  } else {
    meta.command_name = v("custom");
    meta[`${PROTECTED_PREFIX}command_name`] = v(opts.commandName);
  }
  emit(EVENT_NAMES.COMMAND_INVOKE, meta);
}

/** 命令被拒的原因。`unknown_command` 的分布能直接看出「用户以为存在但其实没有」的功能。 */
export type CommandRejectReason =
  | "unknown_command"
  | "not_user_invocable"
  | "disabled"
  | "parse_error";

/**
 * ⚠️ **本事件仅在斜杠命令被拒时触发（打错名字 / 命令被禁用 / 只供模型调用 /
 * 解析失败），本机长期为 0 属正常，不是接线缺陷**（P1-6 分诊结论，勿重复分诊）。
 *
 * 判 a 类的证据：4 个调用点全在 `cli/src/command/executor.ts`
 * 的 `executeSlashCommand` 里，而**同一个方法**尾部的 `dispatch → logCommandInvoke`
 * 已落盘 41 条 —— 方法可达，只是 41 次调用全部命中了存在且可用的命令，
 * 四个拒绝分支一个都没进。`~/.sid-code/command-usage.json` 里
 * 记录的也全是真实存在的命令（skills / clear / stats / plugin / memory / config / mcp）。
 *
 * 分母提示：这条的分母是「用户敲下的斜杠命令总数」（≈ command_invoke + command_rejected），
 * 用全量会话数当分母会把 unknown_command 率稀释到看不见。
 */
export function logCommandRejected(reason: CommandRejectReason): void {
  emit(EVENT_NAMES.COMMAND_REJECTED, { reason: v(reason) });
}

// ─────────────────────────────────────────────────────────────
// 漏斗 5 · 错误
// ─────────────────────────────────────────────────────────────

/**
 * 错误发生。`category` 必须来自既有分类器（`classifyAPIError` 等）或调用点的结构化分支，
 * **不要在这里用裸子串猜**——那正是记忆里「归因与真实信号脱节」记的反模式。
 *
 * 刻意不接收错误消息文本：错误消息里常带文件路径、命令行、甚至密钥片段。
 * 需要定位具体错误时看本地日志与 raw.jsonl，遥测只出分型。
 *
 * ⚠️ **本事件仅在 queryLoop 抛出异常并被 engine 封装成 `fatal_error` 时触发，
 * 本机长期为 0 属正常，不是接线缺陷**（P1-6 分诊结论，勿重复分诊）。
 *
 * 先纠正一个会误导后人的计数：分诊前的清单写「9 个调用点却 0 落盘，最可疑」。
 * 实测**本函数只有 1 个生产调用点**（`query/engine.ts` 的 queryLoop catch 块）。
 * 另外 8 处是三个**同名但完全无关**的函数：
 *   - `tui-renderer/src/_vendor/log.ts` 的 ink 渲染期 stderr 打印（4 处引用）；
 *   - `cli/src/state/bootstrap.ts` 的进程内存错误环形缓冲；
 *   - `cli/src/entrypoints/headless.ts` 里一个写 stderr 的局部闭包（3 处调用）。
 * 按函数名 grep 会把它们全算进来 —— 这正是「'有无引用'测不出接线状态」的又一例。
 *
 * 为什么 1 个调用点 + 本机 6 次 `exit_status=error` 仍然对得上（不是漏采）：
 * 那 6 次错误退出**没有一次**走 engine 的 catch。逐个核对 warn.log，窗口内的三次
 * （20260809-044734 / 20260810-214525 / 20260811-060605）全部终结于
 * `[GLOBAL] uncaughtException`（EPIPE / EIO，终端已死时写 stdout 失败），
 * 由 `cli.ts` 的 `process.on("uncaughtException")` → `app.emergencySessionEnd()`
 * → `fireSessionEndEvent("error")` 直接落 `exit_status=error` 后 `process.exit(1)`。
 * 这条路径根本不经过 queryLoop 的 catch，且全库 `"phase":"engine"` 与
 * `fatal_error` 的轨迹记录都是 0 条 —— 两个独立信号互相印证。
 *
 * 所以「exit_status=error 有 6 次」推不出「engine 埋点漏了」：
 * 两者统计的是不同事件（进程级崩溃 vs 主循环内异常）。真想覆盖崩溃类错误，
 * 应当在 emergencySessionEnd 另起一条埋点 —— 但那条路径上进程即将 exit(1)，
 * 而本地 backend 是 `writeChain` 异步追加写，**发了也大概率来不及落盘**；
 * 要做得先解决刷盘时序，不是在这里补一次调用就完事。故本次不动，如实记录待办。
 */
export function logError(opts: {
  category: string;
  /** 出错的子系统（api / tool / hook / mcp / trace …），固定枚举 */
  source: string;
  retryable?: boolean;
  extra?: Record<string, unknown>;
}): void {
  emit(
    EVENT_NAMES.ERROR_OCCURRED,
    withExtra(
      {
        error_category: v(opts.category),
        error_source: v(opts.source),
        ...(opts.retryable !== undefined ? { retryable: opts.retryable } : {}),
      },
      opts.extra,
    ),
  );
}

/**
 * 从异常对象提取**结构化**错误码，用于 tool_failure 的 error_code。
 *
 * 只读 `code` / `errno` / `status` 这类结构化字段，不解析 message 文本。
 * 判据优先级沿用「状态码 / reason 白名单 > 数字边界 > 裸子串」，此处到第一级就停。
 */
export function structuredErrorCode(err: unknown): string | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const e = err as { code?: unknown; errno?: unknown; status?: unknown };
  if (typeof e.code === "string" && e.code.length > 0 && e.code.length <= 32) return e.code;
  if (typeof e.status === "number") return `http_${e.status}`;
  if (typeof e.errno === "number") return `errno_${e.errno}`;
  return undefined;
}
