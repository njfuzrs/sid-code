/**
 * 只写 logger 的引导规则 / 边界检查补触发事件（厚薄归位专项 HB-4，2026-11-10）
 *
 * ## 为什么集中在这里
 *
 * 这批规则的发射点散在 `tool/`、`context/`、`query/compact/` 里，调用方不持有 collector，
 * 只能走「模块级 sink + App 在 collector 就绪后接线」（同 edit-failure-tracker / background-poll-guard）。
 * 把 sink 和事件名常量集中放到 `query/`，是为了让 `defense-registry-complete.test.ts` 的
 * `*_EVENT_NAME` 解析扫得到：放在 `tool/` 下，注册表门禁看不见，新增发射点也就不用登记。
 *
 * ## 只加事件、不改行为
 *
 * 每个 emit 都是旁路：没接 sink（单测 / 无 collector）直接返回，sink 抛错也吞掉。
 * 事件里**不放内容原文**（不放命令、URL 路径、文件内容、凭证片段），只放闭集标签与计数，
 * 与 PermissionDecision 的 guard 字段同一条口径。
 */

// ─────────────────────────── 事件名 ───────────────────────────

/** T8：write / edit 因省略占位符被拒（`// ... existing code` 一类） */
export const OMISSION_REJECTED_EVENT_NAME = "OmissionRejected";
/** C1/C2：压缩管线把旧工具结果替换成「请重新执行」类占位（tool_result_budget / microcompact） */
export const TOOL_RESULT_CLEARED_EVENT_NAME = "ToolResultCleared";
/** B18：工具输出里检出凭证形态数据，已进入上下文 */
export const CREDENTIAL_IN_CONTEXT_EVENT_NAME = "CredentialInContext";
/** B18：web_fetch 的 URL 既非用户提及也非预授权域名（模型自造），交确认 */
export const WEB_FETCH_MODEL_URL_EVENT_NAME = "WebFetchModelUrl";
/** B18：记忆写入闸门命中（拒写 secret、scope 越权、索引满等），此前只进 analytics */
export const MEMORY_GUARD_EVENT_NAME = "MemoryGuard";
/** N6 A 档：前台 `sleep N` 阻塞等待已追加引导（只追加提示，不拦、不改退出码） */
export const FOREGROUND_SLEEP_GUIDED_EVENT_NAME = "ForegroundSleepGuided";

// ─────────────────────────── sink ───────────────────────────

export type GuidanceEventName =
  | typeof OMISSION_REJECTED_EVENT_NAME
  | typeof TOOL_RESULT_CLEARED_EVENT_NAME
  | typeof CREDENTIAL_IN_CONTEXT_EVENT_NAME
  | typeof WEB_FETCH_MODEL_URL_EVENT_NAME
  | typeof MEMORY_GUARD_EVENT_NAME
  | typeof FOREGROUND_SLEEP_GUIDED_EVENT_NAME;

type GuidanceSink = (event: GuidanceEventName, data: Record<string, unknown>) => void;
let sink: GuidanceSink | null = null;

/** 注入/清除事件通道（App 在 collector 就绪后调用；测试收尾传 null 复位） */
export function setGuidanceEventSink(s: GuidanceSink | null): void {
  sink = s;
}

function emit(event: GuidanceEventName, data: Record<string, unknown>): void {
  if (!sink) return;
  try {
    sink(event, { ...data, ts: Date.now() });
  } catch {
    /* 埋点失败不影响主流程 */
  }
}

/** 只留文件名：归类用不到完整路径（同 EditFailureReminder.file） */
function baseName(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

// ─────────────────────────── emit ───────────────────────────

/**
 * T8。`patterns` 是 omission-detector 的规则名（闭集），不是命中行原文 —— 原文可能是用户代码。
 * 误拒率的取数：本事件之后同文件下一次 write/edit 是否成功、命中规则是否落在字符串或注释里
 * （后者要人工抽样，事件只给定位）。
 */
export function emitOmissionRejected(data: {
  tool_name: "write" | "edit";
  file_path: string;
  patterns: string[];
  match_count: number;
}): void {
  emit(OMISSION_REJECTED_EVENT_NAME, {
    tool_name: data.tool_name,
    file: baseName(data.file_path),
    patterns: [...new Set(data.patterns)],
    match_count: data.match_count,
  });
}

/**
 * C1/C2。`tool_use_ids` 是被清掉的那些调用，后效指标「清理后 N 轮内同签名重跑」靠它回到
 * PreToolUse 取签名。`stage` 区分管线哪一步（占位文案不同，重跑诱因也不同）。
 */
export function emitToolResultCleared(data: {
  stage: "tool_result_budget" | "microcompact" | "stale_clear";
  cleared: number;
  saved_chars: number;
  tool_use_ids: string[];
}): void {
  if (data.cleared <= 0) return;
  emit(TOOL_RESULT_CLEARED_EVENT_NAME, data);
}

/** B18。`kinds` 是 detectSensitiveData 的类型名（闭集），不含命中片段 */
export function emitCredentialInContext(data: {
  tool_use_id?: string;
  hit_count: number;
  kinds: string[];
}): void {
  emit(CREDENTIAL_IN_CONTEXT_EVENT_NAME, {
    ...(data.tool_use_id ? { tool_use_id: data.tool_use_id } : {}),
    hit_count: data.hit_count,
    kinds: [...new Set(data.kinds)],
  });
}

/** B18。只记 origin（scheme+host+port），不记路径与查询串 —— 外泄尝试的载荷常在那里 */
export function emitWebFetchModelUrl(data: { origin: string }): void {
  emit(WEB_FETCH_MODEL_URL_EVENT_NAME, data);
}

/** B18。字段与 analytics 的 memory_guard 同名同值（闭集），两边可对账 */
export function emitMemoryGuard(data: { kind: string; via: string; scope?: string }): void {
  emit(MEMORY_GUARD_EVENT_NAME, {
    guard_kind: data.kind,
    guard_via: data.via,
    ...(data.scope !== undefined ? { memory_scope: data.scope } : {}),
  });
}

/**
 * N6 A 档。前台 `sleep N` 阻塞本轮时追加的引导（只追加提示，命令照常执行）。
 *
 * `reason` 是闭集标签：`declared_wait` = 模型自己挂了等待源（唤醒 / monitor / wait_until），
 * 前台 sleep 正在推迟它；`long_sleep` = 没有等待源，但 N 已过 30s 阈值。
 * 上线后回看的取数口径：本事件数 ÷ 前台 sleep 命中数 = 引导覆盖率；
 * 后效看 `unwaited_longest_run`（N7 的字段）有没有下降。
 */
export function emitForegroundSleepGuided(data: {
  seconds: number;
  has_declared_wait: boolean;
  reason: "declared_wait" | "long_sleep";
}): void {
  emit(FOREGROUND_SLEEP_GUIDED_EVENT_NAME, data);
}
