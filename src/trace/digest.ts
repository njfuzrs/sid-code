/**
 * trace digest —— sid-code 可观测性"一键嚼碎"核心逻辑
 *
 * 把"定位 session 文件 + 解析 .traj + 找异常点 + 指出该看哪个原始文件"这件确定性的脏活
 * 从 AI 的概率推理里抽出来,固化成代码。被两处复用:
 *   - scripts/trace-digest.ts —— CLI 脚本(claude code / 终端直接跑)
 *   - src/command/builtins.ts TraceCommand —— sid-code 内置 /trace 命令
 *
 * 本模块是纯逻辑:不读 process.argv、不直接写 stdout/stderr、不调 process.exit。
 * 所有路径通过 resolvePaths(root) 注入(默认从环境变量/homedir 推导),便于测试与隔离。
 *
 * 数据来源(全部只读,绝不修改):
 *   {root}/trajectories/sessions/{id}/session.traj   主轨迹(TAO 步骤+metadata)
 *   {root}/trajectories/sessions/{id}/raw.jsonl      原始请求/响应对
 *   {root}/trajectories/sessions/{id}/messages.json  崩溃验尸快照(可选)
 *   {root}/trajectories/sessions/{id}/events.jsonl   会话级 Hook 事件
 *   {root}/usage-ledger.jsonl                        跨会话用量账本
 *   {root}/protocol-violations/*.json                协议违规(孤儿 tool_use 等)
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─────────────────────────── 路径 ───────────────────────────

export interface DigestPaths {
  root: string;
  sessionsDir: string;
  ledgerPath: string;
  violationsDir: string;
}

/** 解析所有数据路径。root 缺省时按 SID_CODE_HOME → ~/.sid-code 推导。 */
export function resolvePaths(root?: string): DigestPaths {
  const r = root || process.env.SID_CODE_HOME || join(homedir(), ".sid-code");
  return {
    root: r,
    sessionsDir: join(r, "trajectories", "sessions"),
    ledgerPath: process.env.SID_CODE_USAGE_LEDGER || join(r, "usage-ledger.jsonl"),
    violationsDir: join(r, "protocol-violations"),
  };
}

// ─────────────────────────── 类型 ───────────────────────────

export interface TrajStep {
  message_type?: string; // "action" | "observation"
  role?: string;
  content?: unknown;
  thought?: string;
  action?: string; // 形如 read({...})
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  agent?: string;
  is_error?: boolean;
  _orphan?: boolean;
  timestamp?: number;
}

export interface TrajMeta {
  session_id?: string;
  model?: string;
  start_time?: string | number;
  end_time?: string | number;
  total_steps?: number;
  total_api_calls?: number;
  total_tokens_sent?: number;
  total_tokens_received?: number;
  total_cost_usd?: number;
  exit_status?: string;
  tools_used?: string[];
  files_edited?: string[];
  working_directory?: string;
  has_thinking?: boolean;
  has_sub_agent?: boolean;
  user_prompts?: string[];
  compactions?: number;
}

export interface TrajFile {
  trajectory?: TrajStep[];
  history?: unknown[];
  info?: { model_stats?: Record<string, number>; exit_status?: string; has_thinking?: boolean };
  metadata?: TrajMeta;
}

export interface LedgerEntry {
  ts: number;
  sessionId: string;
  model: string;
  provider?: string;
  promptTotal: number;
  cacheHit: number;
  cacheWrite: number;
  uncachedInput: number;
  output: number;
  costUSD: number;
  savingsUSD: number;
  durationMs: number;
}

export interface Anomaly {
  severity: "high" | "medium" | "low";
  kind: string;
  detail: string;
  pointer?: string; // 该看哪个原始文件/行
}

export interface ToolStep {
  idx: number;
  tool: string;
  argPreview: string;
  isError: boolean;
  orphan: boolean;
}

export interface Digest {
  sessionId: string;
  model: string;
  exitStatus: string;
  abnormal: boolean;
  durationMs: number;
  apiCalls: number;
  totalSteps: number;
  costUSD: number;
  tokensSent: number;
  tokensReceived: number;
  workingDir: string;
  userPrompts: string[];
  toolsUsed: string[];
  filesEdited: string[];
  toolSequence: ToolStep[];
  thinkingHighlights: string[];
  anomalies: Anomaly[];
  pointers: { label: string; path: string; hint: string }[];
  ledger?: LedgerEntry;
  crash?: { reason?: string; attribution?: unknown };
}

export interface SessionRef {
  id: string;
  dir: string;
  trajPath: string;
  mtimeMs: number;
}

// ─────────────────────────── 工具函数 ───────────────────────────

function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** 逐行读 jsonl,损坏行跳过 */
function readJsonl<T>(path: string, maxLines = Infinity): T[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* 损坏行跳过 */
    }
    if (out.length >= maxLines) break;
  }
  return out;
}

function fmtUsd(n: number | undefined): string {
  if (!n) return "$0";
  return `$${n.toFixed(n < 0.01 ? 6 : 4)}`;
}

function fmtDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return "?";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

// ─────────────────────────── session 定位 ───────────────────────────

/** 列出所有有 session.traj 的会话,按 mtime 降序 */
export function listSessions(paths: DigestPaths): SessionRef[] {
  if (!existsSync(paths.sessionsDir)) return [];
  const refs: SessionRef[] = [];
  for (const id of readdirSync(paths.sessionsDir)) {
    if (id.startsWith(".")) continue;
    const dir = join(paths.sessionsDir, id);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const trajPath = join(dir, "session.traj");
    if (!existsSync(trajPath)) continue;
    let mtimeMs = st.mtimeMs;
    try {
      mtimeMs = statSync(trajPath).mtimeMs;
    } catch {
      /* 用目录 mtime 兜底 */
    }
    refs.push({ id, dir, trajPath, mtimeMs });
  }
  return refs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export interface ResolveResult {
  ref: SessionRef | null;
  /** 非致命提示(并发会话歧义、前缀多命中等),由调用方决定如何展示 */
  warning?: string;
}

/**
 * 解析用户给的 session 标识:latest / 完整 id / 前缀。
 * 不直接写 stderr,提示通过 warning 返回(供 CLI 打 stderr、命令拼进 message)。
 */
export function resolveSession(arg: string | undefined, all: SessionRef[]): ResolveResult {
  if (all.length === 0) return { ref: null };
  if (!arg || arg === "latest") {
    // latest 用 mtime 排序选最近。多会话并发时 mtime 可能选错,
    // 若次近会话与最近会话 mtime 相差 < 2 分钟,给出歧义提示。
    if (all.length >= 2 && all[0].mtimeMs - all[1].mtimeMs < 120_000) {
      return {
        ref: all[0],
        warning:
          `latest 按文件 mtime 选中 ${all[0].id},但 ${all[1].id} 的时间很接近(可能并发会话)。` +
          `如果选错了,用 --list 挑准确的 id。`,
      };
    }
    return { ref: all[0] };
  }
  // 精确匹配
  const exact = all.find((s) => s.id === arg);
  if (exact) return { ref: exact };
  // 前缀匹配
  const prefixed = all.filter((s) => s.id.startsWith(arg));
  if (prefixed.length === 1) return { ref: prefixed[0] };
  if (prefixed.length > 1) {
    return {
      ref: prefixed[0],
      warning: `前缀 "${arg}" 命中 ${prefixed.length} 个会话,取最近一个 (${prefixed[0].id})。全部: ${prefixed
        .map((s) => s.id)
        .join(", ")}`,
    };
  }
  return { ref: null };
}

// ─────────────────────────── 摘要构建 ───────────────────────────

/** 提取 tool_input 的关键参数做预览(不同工具看不同字段) */
function previewArgs(input: Record<string, unknown> | undefined, action: string | undefined): string {
  if (!input || typeof input !== "object") {
    // 退回从 action 字符串里截
    if (action) {
      const m = action.match(/\(([\s\S]*)\)\s*$/);
      if (m) return truncate(m[1], 80);
    }
    return "";
  }
  const anchors = ["file_path", "path", "pattern", "command", "query", "old_string", "url", "prompt", "description"];
  const parts: string[] = [];
  for (const k of anchors) {
    if (k in input && input[k] != null) {
      parts.push(`${k}=${truncate(String(input[k]), 60)}`);
      if (parts.length >= 2) break;
    }
  }
  if (parts.length === 0) {
    const keys = Object.keys(input);
    return keys.length ? `{${keys.slice(0, 3).join(",")}}` : "{}";
  }
  return parts.join(" ");
}

function deriveDuration(meta: TrajMeta): number {
  const toMs = (v: string | number | undefined): number | null => {
    if (v == null) return null;
    if (typeof v === "number") return v < 1e12 ? v * 1000 : v; // 秒→毫秒
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  };
  const start = toMs(meta.start_time);
  const end = toMs(meta.end_time);
  if (start != null && end != null && end >= start) return end - start;
  return 0;
}

/** 粗略匹配协议违规:本会话时间窗内的违规记录数(违规文件名含 ms 时间戳) */
function matchViolations(ref: SessionRef, meta: TrajMeta, paths: DigestPaths): number {
  if (!existsSync(paths.violationsDir)) return 0;
  const start = (() => {
    const v = meta.start_time;
    if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
    if (typeof v === "string") {
      const t = Date.parse(v);
      return isNaN(t) ? 0 : t;
    }
    return 0;
  })();
  if (!start) return 0;
  const end = ref.mtimeMs + 5000;
  let count = 0;
  try {
    for (const f of readdirSync(paths.violationsDir)) {
      const m = f.match(/(\d{13})/);
      if (!m) continue;
      const ts = Number(m[1]);
      if (ts >= start - 5000 && ts <= end) count++;
    }
  } catch {
    /* ignore */
  }
  return count;
}

export function buildDigest(ref: SessionRef, full: boolean, paths: DigestPaths): Digest | null {
  const traj = readJsonSafe<TrajFile>(ref.trajPath);
  if (!traj) return null;

  const meta = traj.metadata || {};
  const steps = traj.trajectory || [];
  const anomalies: Anomaly[] = [];

  // ── Schema 健全性校验(防静默失效)──
  // 本模块与 src/trace/builder.ts 的输出 schema 强耦合:依赖 trajectory[] / metadata 结构。
  // 若 builder 输出格式漂移,readJsonSafe 仍会解析成功,但下面所有提取都会得到空值,
  // 导致"假装无异常"骗过 AI。这里显式检测:解析成功但两个核心键都缺 = 格式不符预期。
  const hasTrajArray = Array.isArray(traj.trajectory);
  const hasMetadata = traj.metadata != null && typeof traj.metadata === "object";
  if (!hasTrajArray && !hasMetadata) {
    anomalies.push({
      severity: "high",
      kind: "数据格式异常",
      detail:
        `session.traj 解析成功但缺 trajectory[] 和 metadata 两个核心字段 —— ` +
        `可能 src/trace/builder.ts 输出 schema 已变更,本模块的字段映射需同步更新。` +
        `下面的摘要可能不可信,请直接看原始文件。`,
      pointer: join(ref.dir, "session.traj"),
    });
  }

  // ── 退出状态判定 ──
  const exitStatus = meta.exit_status || traj.info?.exit_status || "unknown";
  const abnormal = ["error", "abort", "user_interrupt"].includes(exitStatus);
  if (exitStatus === "error") {
    anomalies.push({
      severity: "high",
      kind: "异常退出",
      detail: `exit_status=error —— 会话因运行时异常终止`,
      pointer: `messages.json (验尸快照,看 attribution) + raw.jsonl 末行`,
    });
  } else if (exitStatus === "abort") {
    anomalies.push({ severity: "medium", kind: "中止", detail: `exit_status=abort —— 收到 SIGINT/SIGTERM` });
  }

  // ── 工具序列 + 错误/孤儿检测 ──
  const toolSequence: ToolStep[] = [];
  const thinkingHighlights: string[] = [];
  let orphanCount = 0;
  let toolErrorCount = 0;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.message_type === "action" && s.tool_name) {
      toolSequence.push({
        idx: i,
        tool: s.tool_name,
        argPreview: previewArgs(s.tool_input, s.action),
        isError: false,
        orphan: false,
      });
    }
    if (s.message_type === "observation") {
      const last = toolSequence[toolSequence.length - 1];
      if (s._orphan) {
        orphanCount++;
        if (last) last.orphan = true;
      }
      if (s.is_error) {
        toolErrorCount++;
        if (last) last.isError = true;
      } else if (typeof s.content === "string" && /\b(error|failed|exception|拒绝|denied)\b/i.test(s.content)) {
        // observation 文本里透出错误信号(并非所有 is_error 都被标记)
        if (last && !last.isError) last.isError = true;
      }
    }
    // 思维链要点(取前几条,full 模式取更多)
    if (s.thought && typeof s.thought === "string") {
      const limit = full ? 8 : 3;
      if (thinkingHighlights.length < limit) {
        thinkingHighlights.push(truncate(s.thought, full ? 240 : 140));
      }
    }
  }

  if (orphanCount > 0) {
    anomalies.push({
      severity: "high",
      kind: "孤儿 tool_use",
      detail: `${orphanCount} 个 tool_use 无对应 tool_result —— 通常是会话中途崩溃或协议违规`,
      pointer: `protocol-violations/ 目录 + messages.json`,
    });
  }
  if (toolErrorCount > 0) {
    anomalies.push({
      severity: toolErrorCount >= 3 ? "high" : "medium",
      kind: "工具执行失败",
      detail: `${toolErrorCount} 次工具调用报错(见工具序列中标 ✗ 的步骤)`,
    });
  }

  // ── 循环嫌疑:连续相同 (tool + 锚点参数) ──
  let maxRun = 0;
  let maxRunShape = "";
  let prevShape = "";
  let curRun = 0;
  for (const t of toolSequence) {
    const shape = `${t.tool}|${t.argPreview.split(" ")[0] || ""}`;
    if (shape === prevShape) {
      curRun++;
    } else {
      curRun = 1;
      prevShape = shape;
    }
    if (curRun > maxRun) {
      maxRun = curRun;
      maxRunShape = shape;
    }
  }
  if (maxRun >= 4) {
    anomalies.push({
      severity: "medium",
      kind: "疑似循环",
      detail: `工具形状 "${maxRunShape}" 连续出现 ${maxRun} 次 —— 可能在原地打转(参考循环检测 src/agent/loop-detection.ts)`,
    });
  }

  // ── 成本/账本关联 ──
  const ledger = readJsonl<LedgerEntry>(paths.ledgerPath)
    .filter((e) => e.sessionId === ref.id)
    .pop();
  const costUSD = ledger?.costUSD ?? meta.total_cost_usd ?? traj.info?.model_stats?.total_cost_usd ?? 0;
  const durationMs = ledger?.durationMs ?? deriveDuration(meta);

  // 成本归零仅在「有账本条目且账本明确记成本为 0」时才算异常:
  // 没有 ledger 条目(会话没正常 SessionEnd / 未写账本)是数据缺失,不是成本异常,
  // 否则绝大多数历史会话都会误报(实测覆盖率极低)。
  const tokensSent = meta.total_tokens_sent ?? traj.info?.model_stats?.tokens_sent ?? 0;
  const isLocalProvider = ledger?.provider === "ollama" || ledger?.provider === "local";
  if (ledger && tokensSent > 5000 && ledger.costUSD === 0 && !isLocalProvider) {
    anomalies.push({
      severity: "low",
      kind: "成本归零存疑",
      detail: `账本记录消耗 ${tokensSent} input tokens 但 costUSD=0(非本地 provider)—— 可能定价表缺该模型(见 src/session/state.ts calculateCost 兜底)`,
    });
  }

  // ── 协议违规关联(按时间窗匹配) ──
  const crashSnapshot = readJsonSafe<{ reason?: string; attribution?: unknown }>(join(ref.dir, "messages.json"));
  const matchedViolations = matchViolations(ref, meta, paths);
  if (matchedViolations > 0) {
    anomalies.push({
      severity: "medium",
      kind: "协议违规记录",
      detail: `protocol-violations/ 中有 ${matchedViolations} 条疑似与本会话时间相近的记录`,
      pointer: `protocol-violations/`,
    });
  }

  // ── 该看哪个原始文件(指针) ──
  const pointers: Digest["pointers"] = [
    { label: "完整轨迹", path: join(ref.dir, "session.traj"), hint: "TAO 步骤 + history + metadata,SFT/回溯用" },
    {
      label: "原始请求响应",
      path: join(ref.dir, "raw.jsonl"),
      hint: "逐次 API 的 request/response/usage/stop_reason,排查协议/参数问题看这里",
    },
  ];
  if (existsSync(join(ref.dir, "messages.json"))) {
    pointers.push({
      label: "崩溃验尸",
      path: join(ref.dir, "messages.json"),
      hint: "退出归因 attribution + 完整消息历史,异常退出首选",
    });
  }
  if (existsSync(join(ref.dir, "events.jsonl"))) {
    pointers.push({
      label: "会话事件流",
      path: join(ref.dir, "events.jsonl"),
      hint: "Hook 事件时间线(SessionStart/BeforeModel/PostToolUse…)",
    });
  }

  // 按严重度排序异常
  const sevRank = { high: 0, medium: 1, low: 2 } as const;
  anomalies.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

  return {
    sessionId: ref.id,
    model: ledger?.model || meta.model || "unknown",
    exitStatus,
    abnormal,
    durationMs,
    apiCalls: meta.total_api_calls ?? traj.info?.model_stats?.api_calls ?? 0,
    totalSteps: meta.total_steps ?? steps.length,
    costUSD,
    tokensSent,
    tokensReceived: meta.total_tokens_received ?? traj.info?.model_stats?.tokens_received ?? 0,
    workingDir: meta.working_directory || "",
    userPrompts: (meta.user_prompts || []).map((p) => truncate(String(p), full ? 300 : 160)),
    toolsUsed: meta.tools_used || [],
    filesEdited: meta.files_edited || [],
    toolSequence,
    thinkingHighlights,
    anomalies,
    pointers,
    ledger: ledger || undefined,
    crash: crashSnapshot ? { reason: crashSnapshot.reason, attribution: crashSnapshot.attribution } : undefined,
  };
}

// ─────────────────────────── 渲染 ───────────────────────────

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};
type Color = keyof typeof ANSI;

/** 生成一个着色函数;noColor=true 时返回原文(命令面板/管道场景) */
function makeColorizer(noColor: boolean) {
  return (color: Color, s: string): string => (noColor ? s : `${ANSI[color]}${s}${ANSI.reset}`);
}

export interface RenderOptions {
  /** true 则不输出 ANSI 颜色码。命令面板固定传 true,CLI 按 TTY 判断。 */
  noColor?: boolean;
  /** 列表/摘要末尾提示里使用的命令前缀,如 "/trace" 或 "bun scripts/trace-digest.ts" */
  invocation?: string;
}

export function renderHuman(d: Digest, opts: RenderOptions = {}): string {
  const c = makeColorizer(opts.noColor ?? false);
  const L: string[] = [];
  const exitColor: Color = d.abnormal ? "red" : "green";
  L.push(c("bold", `━━━ session ${d.sessionId}  [${c(exitColor, d.exitStatus)}] ━━━`));
  L.push(
    `  模型 ${c("cyan", d.model)}   API ${d.apiCalls} 次   步骤 ${d.totalSteps}   ` +
      `耗时 ${fmtDuration(d.durationMs)}   成本 ${fmtUsd(d.costUSD)}   ` +
      `tok ${d.tokensSent}↑/${d.tokensReceived}↓`,
  );
  if (d.workingDir) L.push(c("gray", `  cwd ${d.workingDir}`));

  if (d.userPrompts.length) {
    L.push("");
    L.push(c("bold", "用户意图:"));
    d.userPrompts.forEach((p, i) => L.push(`  ${i + 1}. ${p}`));
  }

  // 异常区(最重要,放前面)
  L.push("");
  if (d.anomalies.length === 0) {
    L.push(c("green", "✓ 未检出异常信号"));
  } else {
    L.push(c("bold", `⚠ 异常信号 (${d.anomalies.length}):`));
    for (const a of d.anomalies) {
      const sevTag =
        a.severity === "high" ? c("red", "[高]") : a.severity === "medium" ? c("yellow", "[中]") : c("gray", "[低]");
      L.push(`  ${sevTag} ${c("bold", a.kind)}: ${a.detail}`);
      if (a.pointer) L.push(c("gray", `        → 看: ${a.pointer}`));
    }
  }

  // 工具序列
  if (d.toolSequence.length) {
    L.push("");
    L.push(c("bold", `工具序列 (${d.toolSequence.length} 次调用):`));
    const shown = d.toolSequence.slice(0, 40);
    for (const t of shown) {
      const mark = t.isError ? c("red", "✗") : t.orphan ? c("yellow", "○") : c("green", "·");
      const arg = t.argPreview ? c("gray", ` ${t.argPreview}`) : "";
      L.push(`  ${mark} ${c("cyan", t.tool)}${arg}`);
    }
    if (d.toolSequence.length > shown.length) L.push(c("gray", `  … 余 ${d.toolSequence.length - shown.length} 次`));
  }

  // 思维链要点
  if (d.thinkingHighlights.length) {
    L.push("");
    L.push(c("bold", "思维链要点:"));
    d.thinkingHighlights.forEach((t) => L.push(c("dim", `  💭 ${t}`)));
  }

  // 崩溃归因
  if (d.crash?.attribution) {
    L.push("");
    L.push(c("bold", "崩溃归因 (messages.json):"));
    L.push(c("gray", `  ${truncate(JSON.stringify(d.crash.attribution), 400)}`));
  }

  // 原始文件指针
  L.push("");
  L.push(c("bold", "深挖原始数据:"));
  for (const p of d.pointers) {
    L.push(`  ${c("cyan", p.label)}  ${p.path}`);
    L.push(c("gray", `     ${p.hint}`));
  }

  return L.join("\n");
}

export function renderList(all: SessionRef[], opts: RenderOptions = {}): string {
  const c = makeColorizer(opts.noColor ?? false);
  const invocation = opts.invocation || "<id前缀>";
  const L: string[] = [c("bold", `最近 ${Math.min(20, all.length)} 个会话 (共 ${all.length}):`)];
  for (const ref of all.slice(0, 20)) {
    const traj = readJsonSafe<TrajFile>(ref.trajPath);
    const meta = traj?.metadata || {};
    const exit = meta.exit_status || traj?.info?.exit_status || "?";
    const abnormal = ["error", "abort", "user_interrupt"].includes(exit);
    const when = new Date(ref.mtimeMs).toISOString().slice(5, 16).replace("T", " ");
    const prompt = truncate(String((meta.user_prompts || [])[0] || ""), 50);
    const exitTag = abnormal ? c("red", exit.padEnd(14)) : c("green", exit.padEnd(14));
    L.push(`  ${c("cyan", ref.id)}  ${c("gray", when)}  ${exitTag} ${prompt}`);
  }
  L.push("");
  L.push(c("gray", `  用 \`${invocation} <id前缀>\` 看某个会话的详细摘要`));
  return L.join("\n");
}
