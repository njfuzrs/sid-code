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

/**
 * Provenance(出处三元组+) —— 环节②:取证数据强制自带出处与时效。
 *
 * fdb47f30 教训:grep 捞出 `must be passed back` 时,这条数据已和"来自哪个文件、
 * 第几行、文件什么时间写的"剥离 → 模型拿到无主字符串只能猜,把 5/23 的旧日志当成
 * 本会话的 smoking gun。解法不是提醒模型小心,而是让数据自描述:出处、时效、有损标记
 * 直接挂在值旁边,时效矛盾一眼可见,不需要模型额外起意去查。
 */
export interface Provenance {
  /** 来源文件(绝对路径或相对 session 目录的文件名) */
  sourceFile: string;
  /** 可定位指针:行号 / jsonl 行号 / 字段路径(如 metadata.exit_status) */
  lineRef?: string;
  /** 原始值(已截断),让模型一键比对,不必回原文件 */
  rawValue?: string;
  /** 文件最后修改时间(ISO 字符串)。时效矛盾的关键证据(如 debug.log mtime=5/23 与本会话无关) */
  mtime?: string;
  /** 是否经过有损转换(如 strings 撕中文 / grep 去上下文)。true 表示该值不可作字面采信 */
  lossy?: boolean;
}

/**
 * 异常信号 —— 环节①:强制分两层(L0 事实 / L1 假设),结构上不可混淆。
 *
 * fdb47f30 教训:observability 把"信号"和"推测"混在一起输出(`孤儿 tool_use → 可能崩溃`),
 * 模型拿到的不是中性数据而是带结论倾向的数据,第 0 步就被种下错误锚点。解法是把摘要降维时
 * 必然发生的"诊断"显式拆开:
 *
 * - layer="L0" 纯事实层:只放机器可验证的客观量,**禁止判断词**(异常/孤儿/可疑/可能/疑似),
 *   **必须带 provenance**,让模型一键回原始数据核对。
 * - layer="L1" 假设层:允许提出假设,但每条**必须配 falsifier**(证伪条件)——
 *   "要推翻这个假设,需要看到什么"。没有 falsifier 的假设不许进摘要。模型读到 L1 时,
 *   拿到的不是结论,而是一张"去验证它"的待办清单。
 *
 * 生成/消费职责隔离:本模块(摘要生成器)**不替主模型下诊断**。它的产物是"事实 + 待验证
 * 假设清单","它意味着什么"留给主模型,且主模型应先消解 L1 的 falsifier 再采信。
 */
export interface Anomaly {
  /** 分层:L0=纯事实(带 provenance,无判断词) / L1=假设(带 falsifier) */
  layer: "L0" | "L1";
  severity: "high" | "medium" | "low";
  kind: string;
  detail: string;
  /** L0 应填:数据出处(可多条),让时效/归属矛盾直接呈现在数据旁 */
  provenance?: Provenance[];
  /** L1 必填:证伪条件——看到什么证据就推翻此假设 */
  falsifier?: string;
  pointer?: string; // 该看哪个原始文件/行(保留,向后兼容)
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

/** 取文件 mtime 的 ISO 字符串(用于 provenance 时效)。文件不存在/读不到返回 undefined。 */
function fileMtimeIso(path: string): string | undefined {
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return undefined;
  }
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
      layer: "L0",
      severity: "high",
      kind: "schema_missing_core_keys",
      detail:
        `session.traj 解析成功,但 trajectory[] 与 metadata 两个核心键均不存在。` +
        `本模块的字段映射依赖这两个键;它们缺失时下面所有提取均为空值。`,
      provenance: [
        {
          sourceFile: join(ref.dir, "session.traj"),
          lineRef: "trajectory / metadata",
          rawValue: `hasTrajArray=${hasTrajArray}, hasMetadata=${hasMetadata}`,
          mtime: fileMtimeIso(ref.trajPath),
        },
      ],
      pointer: join(ref.dir, "session.traj"),
    });
  }

  // ── 退出状态判定 ──
  const exitStatus = meta.exit_status || traj.info?.exit_status || "unknown";
  const abnormal = ["error", "abort", "user_interrupt"].includes(exitStatus);
  if (exitStatus === "error") {
    // L0:exit_status 的字面值是客观事实,带出处。
    anomalies.push({
      layer: "L0",
      severity: "high",
      kind: "exit_status_error",
      detail: `exit_status = "error"`,
      provenance: [
        {
          sourceFile: join(ref.dir, "session.traj"),
          lineRef: meta.exit_status ? "metadata.exit_status" : "info.exit_status",
          rawValue: "error",
          mtime: fileMtimeIso(ref.trajPath),
        },
      ],
      pointer: `messages.json (验尸快照,看 attribution) + raw.jsonl 末行`,
    });
    // L1:由它推断"运行时异常终止",配证伪条件。
    anomalies.push({
      layer: "L1",
      severity: "high",
      kind: "hypothesis_runtime_abend",
      detail: `假设:会话因运行时异常而非正常 end_turn 终止。`,
      falsifier:
        `若 messages.json.attribution 显示是用户主动中断 / 配额耗尽等可预期原因,` +
        `或进程仍存活且事件流仍在增长,则推翻"运行时异常终止"。`,
      pointer: `messages.json (attribution) + raw.jsonl 末行`,
    });
  } else if (exitStatus === "abort") {
    anomalies.push({
      layer: "L0",
      severity: "medium",
      kind: "exit_status_abort",
      detail: `exit_status = "abort"`,
      provenance: [
        {
          sourceFile: join(ref.dir, "session.traj"),
          lineRef: meta.exit_status ? "metadata.exit_status" : "info.exit_status",
          rawValue: "abort",
          mtime: fileMtimeIso(ref.trajPath),
        },
      ],
    });
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
    // L0:tool_use 无对应 tool_result 是可数的客观事实。
    anomalies.push({
      layer: "L0",
      severity: "high",
      kind: "tool_use_without_result",
      detail: `${orphanCount} 个 tool_use 在轨迹中无对应 tool_result`,
      provenance: [
        {
          sourceFile: join(ref.dir, "session.traj"),
          lineRef: "trajectory[].observation 缺失",
          rawValue: `orphanCount=${orphanCount}`,
          mtime: fileMtimeIso(ref.trajPath),
        },
      ],
      pointer: `protocol-violations/ 目录 + messages.json`,
    });
    // L1:由它推断"中途崩溃/协议违规",配证伪条件。
    // 这正是 fdb47f30 缺的那条:末个 tool_use 在等响应时会话停住,自然没有 tool_result——
    // 这是"卡住"的症状,不是"崩溃"的病因。证伪条件强制模型去查进程是否还活着。
    anomalies.push({
      layer: "L1",
      severity: "medium",
      kind: "hypothesis_crash_or_violation",
      detail: `假设:tool_use 缺 result 是会话中途崩溃或协议违规所致。`,
      falsifier:
        `若产生该 tool_use 的进程仍存活(ps 查 PID)、或它是末次调用且其后正在等模型响应,` +
        `则它只是"尚未返回",不能据此判定崩溃。需先排除"进程存活/正在等待"再采信。`,
      pointer: `protocol-violations/ + messages.json + 用 ps 查会话进程是否存活`,
    });
  }
  if (toolErrorCount > 0) {
    anomalies.push({
      layer: "L0",
      severity: toolErrorCount >= 3 ? "high" : "medium",
      kind: "tool_result_is_error",
      detail: `${toolErrorCount} 次工具调用的 tool_result 标记 is_error(见工具序列中标 ✗ 的步骤)`,
      provenance: [
        {
          sourceFile: join(ref.dir, "session.traj"),
          lineRef: "trajectory[].observation.is_error=true",
          rawValue: `toolErrorCount=${toolErrorCount}`,
          mtime: fileMtimeIso(ref.trajPath),
        },
      ],
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
    // L0:连续相同工具形状的次数是客观计数。
    anomalies.push({
      layer: "L0",
      severity: "low",
      kind: "repeated_tool_shape_run",
      detail: `工具形状 "${maxRunShape}" 连续出现 ${maxRun} 次`,
      provenance: [
        {
          sourceFile: join(ref.dir, "session.traj"),
          lineRef: "trajectory[].action(连续段)",
          rawValue: `shape="${maxRunShape}" run=${maxRun}`,
          mtime: fileMtimeIso(ref.trajPath),
        },
      ],
    });
    // L1:由它推断"原地打转",配证伪条件。
    // 对应 memory loop-detection-false-positive-shape:大文件分段读/多点编辑/反复 bash
    // 都会产生相同 shape 连续段,但都是合法进展,不是循环。
    anomalies.push({
      layer: "L1",
      severity: "medium",
      kind: "hypothesis_stuck_loop",
      detail: `假设:相同工具形状连续出现是 Agent 在原地打转。`,
      falsifier:
        `若这些调用的参数各不相同(分段读不同 offset / 多点编辑不同位置 / bash 跑不同命令),` +
        `则是合法进展而非循环。逐条比对参数后再判定;参考 src/agent/loop-detection.ts shape 定义。`,
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
    // L0:账本里 input>5000 但 costUSD=0 是客观读数。
    anomalies.push({
      layer: "L0",
      severity: "low",
      kind: "ledger_cost_zero_with_tokens",
      detail: `账本记录 ${tokensSent} input tokens 但 costUSD=0(provider=${ledger.provider ?? "?"},非本地)`,
      provenance: [
        {
          sourceFile: paths.ledgerPath,
          lineRef: `sessionId=${ref.id}`,
          rawValue: `tokensSent=${tokensSent}, costUSD=0`,
          mtime: fileMtimeIso(paths.ledgerPath),
        },
      ],
    });
    // L1:由它推断"定价表缺该模型",配证伪条件。
    // fdb47f30 §11 误判:deepseek-v4-pro 明明在 cost-tracker.ts 定价表里,skill 却猜"不在表中"。
    anomalies.push({
      layer: "L1",
      severity: "low",
      kind: "hypothesis_missing_pricing",
      detail: `假设:costUSD=0 是因定价表缺该模型。`,
      falsifier:
        `若 src/api/cost-tracker.ts 的定价表里能 grep 到该模型名,则定价存在,归零另有原因` +
        `(如 usage 未回填 / 本地 provider 漏标)。先 grep 定价表确认模型是否在表再采信。`,
      pointer: `src/api/cost-tracker.ts(定价表)+ src/session/state.ts calculateCost`,
    });
  }

  // ── 协议违规关联(按时间窗匹配) ──
  const crashSnapshot = readJsonSafe<{ reason?: string; attribution?: unknown }>(join(ref.dir, "messages.json"));
  const matchedViolations = matchViolations(ref, meta, paths);
  if (matchedViolations > 0) {
    // L0:时间窗内的违规文件数是客观计数。但"属于本会话"是按时间戳粗匹配的推断 → 归 L1。
    anomalies.push({
      layer: "L0",
      severity: "low",
      kind: "violation_files_in_timewindow",
      detail: `protocol-violations/ 中有 ${matchedViolations} 个文件的时间戳落在本会话时间窗内`,
      provenance: [
        {
          sourceFile: paths.violationsDir,
          lineRef: "文件名内嵌 13 位 ms 时间戳",
          rawValue: `matched=${matchedViolations}`,
          lossy: true, // 仅按时间戳粗匹配,非精确归属
        },
      ],
      pointer: `protocol-violations/`,
    });
    anomalies.push({
      layer: "L1",
      severity: "low",
      kind: "hypothesis_violations_belong_to_session",
      detail: `假设:这些违规记录由本会话产生。`,
      falsifier:
        `时间窗匹配是粗筛。若违规文件内的 session_id / context_window 指向其他会话,` +
        `则与本会话无关。打开违规文件核对其 session 归属再采信。`,
      pointer: `protocol-violations/*.json 内的 session 字段`,
    });
  }

  // ── §3.7：异常路径诊断信号高亮（events.jsonl + errors.jsonl）──
  const eventsPath = join(ref.dir, "events.jsonl");
  const errorsPath = join(ref.dir, "errors.jsonl");
  const events = readJsonl<{ event?: string; data?: Record<string, unknown> }>(eventsPath);
  const errors = readJsonl<{ event?: string; data?: Record<string, unknown> }>(errorsPath);

  // 检测未配对的 BeforeModel（有 BeforeModel 但无 AfterModel/AfterModelRaw/TurnError/ModelCallUnpaired）
  const beforeModels = events.filter(e => e.event === "BeforeModel");
  const afterEvents = events.filter(e =>
    e.event === "AfterModel" || e.event === "AfterModelRaw" || e.event === "TurnError" || e.event === "ModelCallUnpaired",
  );
  const pairedIndices = new Set(afterEvents.map(e => (e.data as any)?.index ?? (e.data as any)?.turn));
  const unpairedBefores = beforeModels.filter(b => !pairedIndices.has((b.data as any)?.index));
  if (unpairedBefores.length > 0) {
    anomalies.push({
      layer: "L0",
      severity: "high",
      kind: "unpaired_before_model",
      detail: `${unpairedBefores.length} 个 BeforeModel 在 events.jsonl 中无配对的 AfterModel/AfterModelRaw/TurnError`,
      provenance: [{
        sourceFile: eventsPath,
        lineRef: `BeforeModel indices: ${unpairedBefores.map(b => (b.data as any)?.index).join(",")}`,
        rawValue: `count=${unpairedBefores.length}`,
        mtime: fileMtimeIso(eventsPath),
      }],
      pointer: `errors.jsonl（若存在）或全局 audit.log`,
    });
    anomalies.push({
      layer: "L1",
      severity: "high",
      kind: "hypothesis_model_call_lost",
      detail: `假设:模型调用发出后未正常返回（hang/崩溃但未被 catch）。`,
      falsifier:
        `若 errors.jsonl 有对应 index 的 Error 记录，则是"收到响应但处理崩溃"而非"请求 hang"。` +
        `若 raw.jsonl 有对应的 request_sent 但无完整记录，确认请求已发出。`,
    });
  }

  // 检测 TurnError 事件（queryLoop 内部崩溃）
  const turnErrors = events.filter(e => e.event === "TurnError");
  if (turnErrors.length > 0) {
    for (const te of turnErrors) {
      anomalies.push({
        layer: "L0",
        severity: "high",
        kind: "turn_error_in_events",
        detail: `TurnError: ${(te.data as any)?.error ?? "unknown"} (turn=${(te.data as any)?.turn})`,
        provenance: [{
          sourceFile: eventsPath,
          lineRef: `event=TurnError turn=${(te.data as any)?.turn}`,
          rawValue: truncate(String((te.data as any)?.error ?? ""), 200),
          mtime: fileMtimeIso(eventsPath),
        }],
        pointer: `errors.jsonl（详细 stack）`,
      });
    }
  }

  // 检测 errors.jsonl 中的错误记录
  if (errors.length > 0) {
    anomalies.push({
      layer: "L0",
      severity: "high",
      kind: "errors_jsonl_has_entries",
      detail: `errors.jsonl 包含 ${errors.length} 条错误记录`,
      provenance: [{
        sourceFile: errorsPath,
        lineRef: `${errors.length} entries`,
        rawValue: errors.slice(0, 3).map(e => truncate(String((e.data as any)?.error ?? ""), 80)).join(" | "),
        mtime: fileMtimeIso(errorsPath),
      }],
      pointer: errorsPath,
    });
  }

  // 检测 SessionEnd 缺失（进程可能被强杀或 hang）
  const hasSessionEnd = events.some(e => e.event === "SessionEnd");
  if (!hasSessionEnd && events.length > 0) {
    anomalies.push({
      layer: "L0",
      severity: "medium",
      kind: "session_end_missing",
      detail: `events.jsonl 有 ${events.length} 条事件但无 SessionEnd`,
      provenance: [{
        sourceFile: eventsPath,
        lineRef: "无 SessionEnd 事件",
        rawValue: `event_count=${events.length}`,
        mtime: fileMtimeIso(eventsPath),
      }],
      pointer: `heartbeat.txt（看最后心跳时间）`,
    });
    anomalies.push({
      layer: "L1",
      severity: "medium",
      kind: "hypothesis_process_killed",
      detail: `假设:进程被强杀或 hang，未能正常触发 SessionEnd。`,
      falsifier:
        `若 heartbeat.txt 的最后时间戳与会话结束时间一致（正常退出只是 SessionEnd hook 漏触发），` +
        `或进程仍存活（ps 查 PID），则推翻此假设。`,
    });
  }

  // 检测 ModelCallUnpaired 事件（看门狗超时触发）
  const unpairedEvents = events.filter(e => e.event === "ModelCallUnpaired");
  if (unpairedEvents.length > 0) {
    for (const ue of unpairedEvents) {
      anomalies.push({
        layer: "L0",
        severity: "high",
        kind: "model_call_unpaired_watchdog",
        detail: `配对看门狗超时: index=${(ue.data as any)?.index} model=${(ue.data as any)?.model} elapsed=${(ue.data as any)?.elapsed_ms}ms`,
        provenance: [{
          sourceFile: eventsPath,
          lineRef: `event=ModelCallUnpaired index=${(ue.data as any)?.index}`,
          rawValue: (ue.data as any)?.hint ?? "",
          mtime: fileMtimeIso(eventsPath),
        }],
        pointer: `raw_preview.jsonl（请求指标）+ audit.log`,
      });
    }
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
      hint: "Hook 事件时间线(SessionStart/BeforeModel/AfterModelRaw/TurnError/PostToolUse…)",
    });
  }
  if (existsSync(join(ref.dir, "errors.jsonl"))) {
    pointers.push({
      label: "错误诊断",
      path: join(ref.dir, "errors.jsonl"),
      hint: "异常路径持久化记录(phase/index/error/stack),崩溃现场首选",
    });
  }

  // 按 layer(L0 事实在前、L1 假设在后)再按严重度排序异常。
  // L0 优先:消费者应先看客观事实,再看建立在事实上的假设。
  const sevRank = { high: 0, medium: 1, low: 2 } as const;
  const layerRank = { L0: 0, L1: 1 } as const;
  anomalies.sort(
    (a, b) => layerRank[a.layer] - layerRank[b.layer] || sevRank[a.severity] - sevRank[b.severity],
  );

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

  // 异常区(最重要,放前面)。环节①:L0 事实层 / L1 假设层物理分开渲染,
  // 不再把"信号"和"推测"混成一锅 —— 让消费者(主模型/人)清楚哪些是客观事实、
  // 哪些是待验证假设(且每条假设都带证伪条件)。
  L.push("");
  const sevTagOf = (a: Anomaly) =>
    a.severity === "high" ? c("red", "[高]") : a.severity === "medium" ? c("yellow", "[中]") : c("gray", "[低]");
  const renderProvenance = (p: Provenance) => {
    const bits = [p.sourceFile];
    if (p.lineRef) bits.push(`@${p.lineRef}`);
    if (p.rawValue) bits.push(`= ${p.rawValue}`);
    const tail: string[] = [];
    if (p.mtime) tail.push(`mtime=${p.mtime}`);
    if (p.lossy) tail.push("有损/粗匹配");
    const tailStr = tail.length ? `  (${tail.join(", ")})` : "";
    return c("gray", `        ⊢ 出处: ${bits.join(" ")}${tailStr}`);
  };

  if (d.anomalies.length === 0) {
    L.push(c("green", "✓ 未检出异常信号"));
  } else {
    const facts = d.anomalies.filter((a) => a.layer === "L0");
    const hyps = d.anomalies.filter((a) => a.layer === "L1");

    // L0 纯事实层:客观量 + 出处,无判断词
    L.push(c("bold", `L0 事实层 (${facts.length}) — 机器可验证,带出处,不含判断:`));
    if (facts.length === 0) {
      L.push(c("gray", "  (无)"));
    } else {
      for (const a of facts) {
        L.push(`  ${sevTagOf(a)} ${c("bold", a.kind)}: ${a.detail}`);
        for (const p of a.provenance ?? []) L.push(renderProvenance(p));
        if (a.pointer) L.push(c("gray", `        → 看: ${a.pointer}`));
      }
    }

    // L1 假设层:每条假设必带证伪条件,提示消费者"先验证再采信"
    L.push("");
    L.push(c("bold", `L1 假设层 (${hyps.length}) — 待验证,先消解证伪条件再采信:`));
    if (hyps.length === 0) {
      L.push(c("gray", "  (无)"));
    } else {
      for (const a of hyps) {
        L.push(`  ${sevTagOf(a)} ${c("bold", a.kind)}: ${a.detail}`);
        if (a.falsifier) L.push(c("yellow", `        ⚖ 证伪条件: ${a.falsifier}`));
        if (a.pointer) L.push(c("gray", `        → 验证看: ${a.pointer}`));
      }
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
