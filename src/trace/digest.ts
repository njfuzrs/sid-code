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
  /** 该 action 派发时刻(ms epoch,解析失败为 undefined)。用于区分并行 fan-out 与串行空转。 */
  tsMs?: number;
}

/** T12.5：Provider 维度聚合统计 */
export interface ProviderDigestStats {
  provider: string;
  requests: number;
  failed: number;
  timedOut: number;
  retried: number;
  /**
   * 整轮 API 耗时均值（ms）。取自 AfterModelRaw.elapsed_ms（= apiDuration，含握手+生成+重试）。
   * 注意：这不是"网关握手延迟"，渲染时须标注为"整轮耗时"，避免与 ttfb（首字节）混淆（Bug B）。
   */
  avgLatencyMs: number;
  /**
   * T14.5 / P0-1：TTFT 分位数（ms）。
   * 取自 StreamPhase("first_content").ttft_ms —— 每次 fetch 在 lifecycle 层独立计算的
   * "首个内容事件（content_block_delta，含思考/工具）延迟"，不含重试污染、不受可视文本延迟影响。
   * 弃用被污染的 AfterModelRaw.ttft_ms（那是 loop.ts 重试循环外只设一次基准 + 仅可视文本触发，
   * 会把整轮生成耗时误计为首字节延迟，导致 P50/P95 严重虚高，见排查报告 Bug A）。
   */
  ttft_p50?: number;
  ttft_p95?: number;
  ttft_p99?: number;
  /**
   * P0-1：模型生成耗时分位数（ms）。取自 RetryTelemetry.elapsedMs（单次 fetch 从连接到流结束）。
   * 让"慢在生成"这一主因显式可见——此前 digest 只展示被污染的 TTFT，生成耗时无从体现。
   */
  gen_p50?: number;
  gen_p95?: number;
  gen_p99?: number;
  /** 超时率 > 10% 时标记 warning */
  warning?: string;
}

/**
 * 第 5 批：JIT 上下文度量聚合（消费 `jit_context` 事件）。
 *
 * 埋点（第 1 批）只解决了「有没有数据」，本结构解决「数据能不能回答问题」。
 * 四个问题对应四组字段，字段口径与 `app.ts:recordJitEvent` 的产出严格一一对应：
 *  1. **触发了几次、命中率多少** → `injections` / `hits` / `hitRate`
 *  2. **注入了多少字节、累积多少** → `injectedBytes` / `cumulativeBytes`（§10.3 的成本曲线）
 *  3. **浪费了多少** → `scopeSkipped` / `wasteRate`（有规则文件但作用域没命中 = 白扫）
 *  4. **进不进 TTFT** → `elapsedP50` / `elapsedP95`（P2-3 fire-and-forget 的实测验收）
 */
export interface JitDigestStats {
  /** JIT 发现被触发的次数（= `jit_context` 事件条数，含未命中） */
  injections: number;
  /** 其中命中（加载到至少一份规则）的次数 */
  hits: number;
  /** 命中率 = hits / injections。分母含未命中才是真覆盖率（见埋点注释） */
  hitRate: number;
  /** 累计加载的规则文件份数（同一文件多次重载会重复计数） */
  loadedCount: number;
  /** 去重后的规则文件数（按相对路径） */
  uniqueFiles: number;
  /** 本次会话累计注入字节（各次 `injected_bytes` 之和） */
  injectedBytes: number;
  /**
   * 会话级累积量峰值（取 `cumulative_bytes` 最大值）。
   * §10.3 已论证治理重点是**累积总量**而非单份大小 —— 这个字段就是那条曲线的终点值。
   * 与 `injectedBytes` 的差别：后者是"注入动作"之和（含重载的重复计入），
   * 前者是 manager 当前持有的去重后总量，即真正每轮携带进上下文的成本。
   */
  cumulativeBytes: number;
  /** 因 `paths:` 作用域未命中而跳过的文件数 */
  scopeSkipped: number;
  /**
   * 浪费率 = scopeSkipped / (loadedCount + scopeSkipped)。
   * 分母是"扫到的带规则文件总数"，所以这个比值答的是
   * 「找到的规则里有多大比例白扫了」，而不是「触发里有多少次没用」。
   */
  wasteRate: number;
  /** 超过大小告警阈值的文件份数（P2-2：仅告警不截断） */
  oversized: number;
  /** 读取失败次数（P2-8：ENOENT 不计入，这里都是真实错误） */
  failures: number;
  /** 失败明细（按 code 聚合，便于一眼看出是权限问题还是编码问题） */
  failureCodes: Record<string, number>;
  /** 加载归因分布（`nested_traversal` / `path_glob_match` / `local` / `rules_dir`） */
  reasonCounts: Record<string, number>;
  /** 单次 JIT 发现耗时分位数（ms）—— 验证 P2-3 是否真的不进关键路径 */
  elapsedP50?: number;
  elapsedP95?: number;
  /** 字节数最大的前几份规则文件（定位"谁在吃上下文"） */
  topFiles: Array<{ path: string; bytes: number; reason: string }>;
}

/**
 * 单个子代理执行 span（digest 消费视角）。
 *
 * 由 events.jsonl 的 SubagentStart / SubagentStop 事件配对而成：
 * Start 提供 agent_id / agent_type / description 与起始时间戳，
 * Stop 提供 status（成败）/ turns / elapsed_ms / tokens 与结束时间戳。
 * 配对策略优先按 agent_id 精确匹配（§9.8 已让 Stop 携带 agent_id），
 * 缺 agent_id 时回退到"最近一个未闭合的 Start"时序匹配。
 */
export interface SubAgentSpan {
  agentId: string;
  agentType: string;
  /** 派活意图（§9.2：SubagentStart 已携带 description） */
  description?: string;
  startTs?: string;
  endTs?: string;
  /** 由 Stop 事件的 status 映射：completed=成功、error=失败、unknown/未闭合=未知 */
  status: "completed" | "error" | "unknown";
  turns?: number;
  elapsedMs?: number;
  outputTokens?: number;
  inputTokens?: number;
  /** 与上一个 span 结束时间的间隔（毫秒）。<1000ms 视为串行排队的强信号。 */
  gapFromPrevMs?: number;
}

/**
 * 子代理执行汇总（digest 的子代理 section）。
 *
 * 直接回答"派了几个子代理、几成几败、是串行还是并行"——让任何读 digest 的
 * 消费者（模型/人）无需回 raw.jsonl 交叉验证即可判断成败与并发行为，
 * 消灭"全部 SUCCESS"类误判（评估报告 §8.2 的 cc 决定性失误）。
 */
export interface SubAgentSummary {
  total: number;
  succeeded: number;
  failed: number;
  unknown: number;
  /** 执行模式判定：serial=全部首尾相接串行、parallel=存在时间重叠、mixed=部分重叠、single=仅一个 */
  concurrency: "serial" | "parallel" | "mixed" | "single";
  /** 串行判定的证据文本（相邻 span 的间隔），供渲染层直接展示 */
  serialEvidence?: string;
  spans: SubAgentSpan[];
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
  /** T12.5：按 Provider 聚合的健康诊断 */
  providerStats?: ProviderDigestStats[];
  /** §9.6：子代理执行汇总（几成几败 + 串行/并行判定）。无子代理时 undefined。 */
  subAgents?: SubAgentSummary;
  /** 第 5 批：JIT 上下文度量。无 `jit_context` 事件时 undefined（老会话/JIT 关闭）。 */
  jit?: JitDigestStats;
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

/** 字节数人类可读（JIT 度量的字节量级横跨 B~百 KB，统一收口避免各处手写除法） */
function fmtBytes(n: number | undefined): string {
  if (!n || n <= 0) return "0B";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

/** 取文件 mtime 的 ISO 字符串(用于 provenance 时效)。文件不存在/读不到返回 undefined。 */
function fileMtimeIso(path: string): string | undefined {
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * 解析轨迹步骤时间戳为 ms epoch。
 * builder 写出的是 ISO 字符串(见 builder.ts:645 等),但历史/其他来源可能是数字 epoch(秒或毫秒),
 * 这里统一容错解析:字符串走 Date.parse,数字按大小判断秒/毫秒,失败返回 undefined。
 */
function parseStepTsMs(ts: unknown): number | undefined {
  if (typeof ts === "string") {
    const ms = Date.parse(ts);
    return Number.isNaN(ms) ? undefined : ms;
  }
  if (typeof ts === "number" && Number.isFinite(ts)) {
    // < 1e12 视为秒级 epoch(2001 年之前的毫秒 epoch 不会出现在轨迹里),换算成毫秒
    return ts < 1e12 ? ts * 1000 : ts;
  }
  return undefined;
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

/**
 * 从 events.jsonl 的 SubagentStart / SubagentStop 事件构建子代理执行汇总。
 *
 * 数据来源（§9.2/§9.8 已让 collector 落盘这些字段）：
 * - SubagentStart.data: { agent_id, agent_type, description }
 * - SubagentStop.data:  { agent_id, status(completed|error|unknown), turns, elapsed_ms, output_tokens, input_tokens }
 *
 * 配对策略：优先按 agent_id 精确匹配 Stop→Start；缺 agent_id（旧轨迹）时
 * 回退到"最近一个未闭合的 Start"时序匹配（与 collector 的 span 闭合逻辑一致）。
 *
 * 串行/并行判定：按 startTs 排序后，逐个看相邻 span 的时间关系——
 * - 后一个的 start 晚于前一个的 end（有正间隔且无重叠）→ 串行段
 * - 后一个的 start 早于前一个的 end（时间重叠）→ 并行段
 * 全串行=serial、全并行=parallel、混合=mixed、单个=single。
 * 串行时把相邻间隔（如"3ms/1ms/2ms"）作为证据文本输出——这正是评估报告
 * §8.4 中 DeepSeek 用来识别"假并行真串行"的铁证，让 digest 直接给出结论。
 *
 * 返回 null 表示本会话无子代理事件。
 */
function buildSubAgentSummary(
  events: Array<{ event?: string; data?: Record<string, unknown> }>,
): SubAgentSummary | null {
  const starts = events.filter((e) => e.event === "SubagentStart");
  const stops = events.filter((e) => e.event === "SubagentStop");
  if (starts.length === 0 && stops.length === 0) return null;

  // 1. 用 Start 事件建 span（保留出现顺序，后面按 startTs 排序）
  const spans: SubAgentSpan[] = starts.map((e) => {
    const d = (e.data as any) ?? {};
    return {
      agentId: String(d.agent_id ?? ""),
      agentType: String(d.agent_type ?? "unknown"),
      description: d.description != null ? String(d.description) : undefined,
      startTs: typeof (e as any).timestamp === "string" ? (e as any).timestamp : d.timestamp,
      status: "unknown" as const,
    };
  });

  // 2. 把 Stop 事件回填到对应 span
  const usedStop = new Set<number>();
  const matchByAgentId = (agentId: string): SubAgentSpan | undefined => {
    if (!agentId) return undefined;
    // 从后往前找同 agent_id 且尚未闭合的 span
    for (let i = spans.length - 1; i >= 0; i--) {
      if (spans[i].agentId === agentId && !spans[i].endTs) return spans[i];
    }
    return undefined;
  };
  const matchLatestOpen = (): SubAgentSpan | undefined => {
    for (let i = spans.length - 1; i >= 0; i--) {
      if (!spans[i].endTs) return spans[i];
    }
    return undefined;
  };

  for (let si = 0; si < stops.length; si++) {
    const e = stops[si];
    const d = (e as any).data ?? {};
    const stopTs = typeof (e as any).timestamp === "string" ? (e as any).timestamp : d.timestamp;
    const agentId = String(d.agent_id ?? "");
    let span = matchByAgentId(agentId) ?? matchLatestOpen();
    // 没有任何 Start 可配对（只有 Stop 的畸形轨迹）：凭空造一个 span，不丢数据
    if (!span) {
      span = {
        agentId,
        agentType: String(d.agent_type ?? "unknown"),
        status: "unknown",
      };
      spans.push(span);
    }
    usedStop.add(si);
    span.endTs = stopTs;
    const rawStatus = d.status;
    span.status =
      rawStatus === "completed" ? "completed" : rawStatus === "error" ? "error" : "unknown";
    if (typeof d.turns === "number") span.turns = d.turns;
    if (typeof d.elapsed_ms === "number") span.elapsedMs = d.elapsed_ms;
    if (typeof d.output_tokens === "number") span.outputTokens = d.output_tokens;
    if (typeof d.input_tokens === "number") span.inputTokens = d.input_tokens;
  }

  // 3. 按 startTs 排序，算相邻间隔 + 判定串行/并行
  const parseTs = (ts?: string): number => {
    if (!ts) return NaN;
    const n = Date.parse(ts);
    return Number.isNaN(n) ? NaN : n;
  };
  spans.sort((a, b) => {
    const ta = parseTs(a.startTs);
    const tb = parseTs(b.startTs);
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return ta - tb;
  });

  let serialPairs = 0;
  let overlapPairs = 0;
  const gapTexts: string[] = [];
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1];
    const cur = spans[i];
    const prevEnd = parseTs(prev.endTs);
    const curStart = parseTs(cur.startTs);
    if (Number.isNaN(prevEnd) || Number.isNaN(curStart)) continue;
    const gap = curStart - prevEnd;
    cur.gapFromPrevMs = gap;
    if (gap >= 0) {
      serialPairs++;
      // 只对"紧贴着排队"的小间隔留证据（串行铁证），大间隔是正常的先后调用
      if (gap < 1000) gapTexts.push(`#${i + 1} 距 #${i} 结束 ${gap}ms`);
    } else {
      overlapPairs++;
    }
  }

  let concurrency: SubAgentSummary["concurrency"];
  if (spans.length <= 1) {
    concurrency = "single";
  } else if (overlapPairs === 0) {
    concurrency = "serial";
  } else if (serialPairs === 0) {
    concurrency = "parallel";
  } else {
    concurrency = "mixed";
  }

  const succeeded = spans.filter((s) => s.status === "completed").length;
  const failed = spans.filter((s) => s.status === "error").length;
  const unknown = spans.filter((s) => s.status === "unknown").length;

  return {
    total: spans.length,
    succeeded,
    failed,
    unknown,
    concurrency,
    serialEvidence: gapTexts.length > 0 ? gapTexts.join("、") : undefined,
    spans,
  };
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
        tsMs: parseStepTsMs(s.timestamp),
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
      }
      // 注:此前这里还有一条"observation 文本含 error/failed/exception/denied 关键词即判失败"的
      // 启发式,已删除——它把 ✗ 打在了成功但内容里恰好出现这些词的调用上(实测:read 一个正文含
      // "error" 34 次的源码文件、或子代理返回的审计报告里提到 "failed",都会被误标 ✗),而截断读取
      // (read.ts 只追加"文件已截断"提示、返回 isError=false)本就不是失败。✗ 现在只信任 tool_result
      // 的权威 is_error 标志(同 loop-detection「信任权威信号、不用粗糙代理」原则)。
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
  //
  // 关键:并行 fan-out(如把一个大任务切成 4 份同时派发 4 个 sub_agent)在轨迹里表现为
  // "连续相同 shape",但它是合法编排而非"一个做完再做下一个"的串行空转。二者的判别信号是
  // **派发时间戳**:并行的几个调用几乎同一时刻发出(间隔 < PARALLEL_DISPATCH_WINDOW_MS),
  // 串行空转则每个调用间隔一次完整的 LLM 往返(秒级以上)。因此计数时把"与上一个近乎同时派发"
  // 的调用视为并行分支,不计入连续 run(既不 ++,也不打断已有 run——它只是被跳过)。
  // 时间戳缺失(老轨迹)时退化为原行为(全部计数),不误伤。
  const PARALLEL_DISPATCH_WINDOW_MS = 1000;
  let maxRun = 0;
  let maxRunShape = "";
  let prevShape = "";
  let prevTsMs: number | undefined;
  let curRun = 0;
  for (const t of toolSequence) {
    const shape = `${t.tool}|${t.argPreview.split(" ")[0] || ""}`;
    const parallelWithPrev =
      shape === prevShape &&
      t.tsMs !== undefined &&
      prevTsMs !== undefined &&
      Math.abs(t.tsMs - prevTsMs) < PARALLEL_DISPATCH_WINDOW_MS;
    if (parallelWithPrev) {
      // 并行分支:跳过,不计入 run。prevShape 保持不变,prevTsMs 更新为本次(供链式并行判定)。
      prevTsMs = t.tsMs;
      continue;
    }
    if (shape === prevShape) {
      curRun++;
    } else {
      curRun = 1;
      prevShape = shape;
    }
    prevTsMs = t.tsMs;
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
      const d = (ue.data as any) ?? {};
      const snap = d.stream_snapshot as Record<string, unknown> | null | undefined;
      // 缺口 3：把流状态快照直接铺进 detail —— 一条异常讲完整个 hang 故事，无需再翻原始 jsonl。
      const snapDetail = snap
        ? ` | 快照: phase=${snap.last_known_phase} http=${snap.http_status_received ? snap.http_status : "未收到"}` +
          ` chunks=${snap.chunks_received} empty=${snap.empty_chunks}` +
          ` 上次进展前=${snap.last_content_progress_ms ?? "?"}ms` +
          ` 超时触发=[${Array.isArray(snap.timeouts_fired) ? (snap.timeouts_fired as unknown[]).join(",") : ""}]` +
          ` abort=${snap.abort_signal_aborted}`
        : ` | 无流快照（hang 发生在 fetch 发出前，或 stream-observer 未初始化）`;
      // 发现 2：区分「慢 vs 死」。看门狗 fire 时若流仍在收 chunk（still_progressing），
      // 是「慢响应」而非 hang——降级为 [低] 且改 kind，避免慢模型（如长响应）被误报 [高] 疑似 hang，
      // 也避免污染 §5 批量分诊选样（见发现 3）。真 hang（无快照/无进展/已 abort）仍报 [高]。
      const stillProgressing = snap?.still_progressing === true;
      anomalies.push({
        layer: "L0",
        severity: stillProgressing ? "low" : "high",
        kind: stillProgressing ? "model_call_slow_response" : "model_call_unpaired_watchdog",
        detail: stillProgressing
          ? `慢响应（超时未配对但流仍在进展，非 hang）: index=${d.index} model=${d.model} elapsed=${d.elapsed_ms}ms${snapDetail}`
          : `配对看门狗超时: index=${d.index} model=${d.model} elapsed=${d.elapsed_ms}ms${snapDetail}`,
        provenance: [{
          sourceFile: eventsPath,
          lineRef: `event=ModelCallUnpaired index=${d.index}`,
          rawValue: snap ? JSON.stringify(snap) : (d.hint ?? ""),
          mtime: fileMtimeIso(eventsPath),
        }],
        pointer: `warn.log（超时相关 WARN）+ raw_preview.jsonl（请求指标）`,
      });
    }
  }

  // ── 缺口 1/2/4：hang 诊断事件消费（StreamPhase/TimeoutFired/TimeoutIneffective/TimeoutRetry/StreamStall）──
  // 目标：打开 digest 摘要即可在 <1 分钟内定位"卡在哪层 + 超时是否生效"，无需手工 grep events.jsonl。
  const timeoutFired = events.filter(e => e.event === "TimeoutFired");
  const timeoutIneffective = events.filter(e => e.event === "TimeoutIneffective");
  const timeoutRetry = events.filter(e => e.event === "TimeoutRetry");
  const timeoutRetryExhausted = events.filter(e => e.event === "TimeoutRetryExhausted");
  const streamStalls = events.filter(e => e.event === "StreamStall");

  // 缺口 2 进阶（本次事故指纹）：超时 fire 了却没生效 —— 最高价值信号，单列 high 异常。
  if (timeoutIneffective.length > 0) {
    for (const ie of timeoutIneffective) {
      const d = (ie.data as any) ?? {};
      anomalies.push({
        layer: "L0",
        severity: "high",
        kind: "timeout_ineffective",
        detail: `超时触发但未生效: layer=${d.layer} index=${d.index} 原因=${d.reason}`,
        provenance: [{
          sourceFile: eventsPath,
          lineRef: `event=TimeoutIneffective layer=${d.layer} index=${d.index}`,
          rawValue: String(d.reason ?? ""),
          mtime: fileMtimeIso(eventsPath),
        }],
        pointer: `事件循环被底层 IO 阻塞导致 Promise.race 无法 settle —— 需不依赖 microtask 的强制中断`,
      });
    }
    anomalies.push({
      layer: "L1",
      severity: "high",
      kind: "hypothesis_event_loop_blocked",
      detail: `假设: 超时定时器 fire 了但 Promise.race 未 settle，事件循环被底层 IO（hang 的 reader.read）占满。`,
      falsifier:
        `若 heartbeat.txt 的 event_loop_lag_ms 持续 >100ms，佐证事件循环阻塞；` +
        `若 lag 正常则是 abort 信号未能中断底层 read（reader.cancel 在 Bun 上不释放 socket）。`,
    });
  }

  // 缺口 2：超时防线触发汇总（哪层 fire 了）
  if (timeoutFired.length > 0) {
    const byLayer = new Map<string, number>();
    for (const tf of timeoutFired) {
      const layer = String((tf.data as any)?.layer ?? "unknown");
      byLayer.set(layer, (byLayer.get(layer) ?? 0) + 1);
    }
    const layerSummary = Array.from(byLayer.entries()).map(([l, c]) => `${l}×${c}`).join(", ");
    anomalies.push({
      layer: "L0",
      severity: "medium",
      kind: "timeout_fired",
      detail: `超时防线触发: ${layerSummary}`,
      provenance: [{
        sourceFile: eventsPath,
        lineRef: `event=TimeoutFired count=${timeoutFired.length}`,
        rawValue: layerSummary,
        mtime: fileMtimeIso(eventsPath),
      }],
      pointer: `若同 index 无对应 TimeoutIneffective，说明超时正常生效（触发即中断）`,
    });
  }

  // 缺口 4：超时重试轨迹（重试了几次 / 是否耗尽）
  if (timeoutRetry.length > 0 || timeoutRetryExhausted.length > 0) {
    const exhausted = timeoutRetryExhausted.length > 0;
    anomalies.push({
      layer: "L0",
      severity: exhausted ? "high" : "medium",
      kind: "timeout_retry",
      detail: `超时重试: ${timeoutRetry.length} 次${exhausted ? `，最终耗尽（${timeoutRetryExhausted.map(e => (e.data as any)?.model).join(",")}）` : ""}`,
      provenance: [{
        sourceFile: eventsPath,
        lineRef: `event=TimeoutRetry×${timeoutRetry.length}${exhausted ? " + TimeoutRetryExhausted" : ""}`,
        rawValue: timeoutRetry.map(e => `attempt=${(e.data as any)?.attempt}/${(e.data as any)?.max}`).join(" "),
        mtime: fileMtimeIso(eventsPath),
      }],
      pointer: exhausted ? `重试耗尽后请求彻底失败，看后续 TurnError/errors.jsonl` : `重试后是否恢复看后续 AfterModel`,
    });
  }

  // 缺口 1：流 stall（长时间无内容进展）—— 定位 hang 在 SSE 消费阶段
  if (streamStalls.length > 0) {
    for (const st of streamStalls) {
      const d = (st.data as any) ?? {};
      anomalies.push({
        layer: "L0",
        severity: "medium",
        kind: "stream_stall",
        detail: `流 stall: index=${d.index} ${Math.round((d.no_content_progress_ms ?? 0) / 1000)}s 无内容进展 chunks=${d.total_chunks} empty=${d.empty_chunks}`,
        provenance: [{
          sourceFile: eventsPath,
          lineRef: `event=StreamStall index=${d.index}`,
          rawValue: JSON.stringify(d),
          mtime: fileMtimeIso(eventsPath),
        }],
        pointer: `empty_chunks>0 说明网关在发 keepalive 但无业务内容（路径 A：keepalive 绕过 idle 超时）`,
      });
    }
  }

  // ── T13.5：Side-call 健康诊断 ──
  // 判据（对齐 roadmap 规格）：失败率 = failed/total。失败率 > 20% 标记 warning，
  // pointer 只列 top-3 失败最多的 label（而非全量），避免 label 多时刷屏。
  const sessionEndEvent = events.find(e => e.event === "SessionEnd");
  const sideCallData = (sessionEndEvent?.data as any)?.sideCallStats;
  if (sideCallData && sideCallData.failed > 0) {
    const total = sideCallData.total || 0;
    const failRate = total > 0 ? sideCallData.failed / total : 0;
    // top-3：按各 label 失败次数降序取前三
    const top3 = Object.entries(sideCallData.byLabel || {})
      .filter(([, v]: [string, any]) => v.failed > 0)
      .sort(([, a]: [string, any], [, b]: [string, any]) => b.failed - a.failed)
      .slice(0, 3)
      .map(([k, v]: [string, any]) => `${k}(${v.failed}失败)`);
    const failLabelCount = Object.values(sideCallData.byLabel || {}).filter((v: any) => v.failed > 0).length;
    const overflow = failLabelCount > 3 ? ` 等 ${failLabelCount} 类` : "";
    anomalies.push({
      layer: "L0",
      // 失败率 > 20% 视为高严重度（规格判据），否则中等
      severity: failRate > 0.2 ? "high" : "medium",
      kind: "side_call_failures",
      detail: `Side-call 失败 ${sideCallData.failed}/${total}（失败率 ${(failRate * 100).toFixed(1)}%，超时 ${sideCallData.timedOut} 次）${failRate > 0.2 ? " ⚠ 失败率 > 20%" : ""}`,
      provenance: [{
        sourceFile: eventsPath,
        lineRef: `event=SessionEnd sideCallStats`,
        rawValue: JSON.stringify(sideCallData.byLabel),
        mtime: fileMtimeIso(eventsPath),
      }],
      pointer: `失败最多的 side-call（top-3）: ${top3.join(", ")}${overflow}`,
    });
  }

  // ── §9.6：子代理执行汇总（几成几败 + 串行/并行判定）──
  // 直接命中评估报告根因：4 个"并行深挖"的 explore 子代理实际被串行执行（isConcurrencySafe
  // 缺失所致）。digest 读 events.jsonl 的 SubagentStart/Stop 配对成 span，按相邻间隔判串行，
  // 关联 status 成败——让任何消费者（模型/人）无需回 raw.jsonl 交叉验证即可下结论，
  // 消灭 §8.2 的"全部 SUCCESS"误判。
  const subAgents = buildSubAgentSummary(events);
  if (subAgents && subAgents.total > 0) {
    // L0 事实：几成几败（客观计数，带出处）
    anomalies.push({
      layer: "L0",
      severity: subAgents.failed > 0 ? "high" : "low",
      kind: "subagent_execution_outcome",
      detail:
        `子代理 ${subAgents.total} 个：${subAgents.succeeded} 成功 / ${subAgents.failed} 失败` +
        `${subAgents.unknown > 0 ? ` / ${subAgents.unknown} 未知` : ""}（执行模式：${subAgents.concurrency}）`,
      provenance: [
        {
          sourceFile: eventsPath,
          lineRef: "event=SubagentStart/SubagentStop 配对",
          rawValue: `total=${subAgents.total} ok=${subAgents.succeeded} fail=${subAgents.failed} mode=${subAgents.concurrency}`,
          mtime: fileMtimeIso(eventsPath),
        },
      ],
      pointer: `raw.jsonl（子代理 tool_result 实际错误文本）`,
    });

    // L0 事实 + L1 假设：多个子代理却全串行 —— 串行化根因的直接信号
    if (subAgents.total >= 2 && subAgents.concurrency === "serial") {
      anomalies.push({
        layer: "L0",
        severity: "high",
        kind: "subagent_serial_execution",
        detail:
          `${subAgents.total} 个子代理首尾相接串行执行，无时间重叠` +
          `${subAgents.serialEvidence ? `（相邻间隔：${subAgents.serialEvidence}）` : ""}`,
        provenance: [
          {
            sourceFile: eventsPath,
            lineRef: "SubagentStart/Stop 相邻时间戳间隔",
            rawValue: subAgents.serialEvidence ?? `serial, ${subAgents.total} spans`,
            mtime: fileMtimeIso(eventsPath),
          },
        ],
        pointer: `src/agent/tool.ts（SubAgentTool.isConcurrencySafe）+ src/query/tool-executor.ts（分区并发）`,
      });
      anomalies.push({
        layer: "L1",
        severity: "medium",
        kind: "hypothesis_missing_concurrency_safe",
        detail: `假设:多个只读子代理被串行执行，是因 isConcurrencySafe 未对该类型返回 true。`,
        falsifier:
          `若这些子代理是 task/verify 等可写类型（本就应串行保护），或相邻间隔本就 >数秒（正常先后调用），` +
          `则串行是预期行为而非 bug。先确认子代理类型与 AgentDefinition.readOnly 再采信。`,
        pointer: `src/agent/agent-definition.ts（readOnly 声明）+ src/agent/tool.ts:isConcurrencySafe`,
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
  // 缺口 7：per-session warn.log（WARN/ERROR 不被后续会话覆盖，hang 排查关键日志）
  if (existsSync(join(ref.dir, "warn.log"))) {
    pointers.push({
      label: "关键日志",
      path: join(ref.dir, "warn.log"),
      hint: "本会话 WARN/ERROR 持久化(空闲超时/内容进展超时/流式整体超时等),hang 排查首选,不被覆盖",
    });
  }
  // 缺口 5：heartbeat 增强(event_loop_lag_ms + active_request 快照,区分正常等待 vs hang)
  if (existsSync(join(ref.dir, "heartbeat.txt"))) {
    pointers.push({
      label: "心跳快照",
      path: join(ref.dir, "heartbeat.txt"),
      hint: "最后心跳: event_loop_lag_ms>100 说明事件循环阻塞; active_request.elapsed_ms 大且仍在跳=hang",
    });
  }

  // 按 layer(L0 事实在前、L1 假设在后)再按严重度排序异常。
  // L0 优先:消费者应先看客观事实,再看建立在事实上的假设。
  const sevRank = { high: 0, medium: 1, low: 2 } as const;
  const layerRank = { L0: 0, L1: 1 } as const;
  anomalies.sort(
    (a, b) => layerRank[a.layer] - layerRank[b.layer] || sevRank[a.severity] - sevRank[b.severity],
  );

  // ── T12.5：按 Provider 聚合诊断信号 ──
  const providerStats = aggregateProviderStats(events);

  // ── 第 5 批：JIT 上下文度量（命中率 / 字节 / 浪费率 / 耗时分位）──
  const jit = aggregateJitStats(events);

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
    providerStats: providerStats.length > 0 ? providerStats : undefined,
    subAgents: subAgents ?? undefined,
    jit: jit ?? undefined,
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

  // T15.4：Provider 健康摘要
  if (d.providerStats && d.providerStats.length > 0) {
    L.push("");
    L.push(c("bold", "Provider 健康:"));
    for (const ps of d.providerStats) {
      const successRate = ps.requests > 0 ? ((ps.requests - ps.failed - ps.timedOut) / ps.requests * 100).toFixed(0) : "N/A";
      // P0-1：TTFT 现取自纯净的 first_content（首内容延迟，不含重试/生成污染）
      const ttft = ps.ttft_p50 ? ` TTFT(首字节)P50=${(ps.ttft_p50 / 1000).toFixed(1)}s` : "";
      // P0-1：新增生成耗时分位，让"慢在生成"这一主因显式可见
      const gen = ps.gen_p50 ? ` 生成P50=${(ps.gen_p50 / 1000).toFixed(1)}s` : "";
      // Bug B：avgLatencyMs 是整轮 API 耗时（含握手+生成+重试），标注清楚，不是网关握手延迟
      const roundtrip = ` 整轮均耗:${(ps.avgLatencyMs / 1000).toFixed(1)}s`;
      const warn = ps.warning ? c("yellow", ` ⚡${ps.warning}`) : "";
      L.push(`  ${c("cyan", ps.provider.padEnd(12))} 请求:${ps.requests} 成功率:${successRate}%${roundtrip}${ttft}${gen}${warn}`);
    }
  }

  // 第 5 批：JIT 上下文 section。验收标准就是这一节能直接答出
  // 「命中率多少 / 平均注入多少字节 / 浪费率多少」，不用再手工 grep events.jsonl。
  if (d.jit) {
    const j = d.jit;
    L.push("");
    const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
    // 命中率低不一定是 bug（很多目录本来就没规则），但浪费率高一定值得看：
    // 说明扫到的规则大多因 paths: 没命中而白读盘。
    const hitColor: Color = j.hits === 0 ? "gray" : "green";
    L.push(
      c("bold", "JIT 上下文:") +
        " " +
        c(hitColor, `触发 ${j.injections} 次 / 命中 ${j.hits} 次（${pct(j.hitRate)}）`) +
        c("gray", `  加载 ${j.loadedCount} 份（去重 ${j.uniqueFiles}）`),
    );
    const avgBytes = j.injections > 0 ? Math.round(j.injectedBytes / j.injections) : 0;
    L.push(
      c("gray", "  字节: ") +
        `本次注入合计 ${fmtBytes(j.injectedBytes)}（均次 ${fmtBytes(avgBytes)}）` +
        c("gray", "  累积峰值: ") +
        // 累积量是每轮都全量携带的成本（§10.3），超过 40KB 值得警觉
        (j.cumulativeBytes > 40_000
          ? c("yellow", `${fmtBytes(j.cumulativeBytes)} ⚡累积偏高`)
          : fmtBytes(j.cumulativeBytes)),
    );
    if (j.scopeSkipped > 0 || j.loadedCount > 0) {
      const wasteColor: Color = j.wasteRate > 0.5 ? "yellow" : "gray";
      L.push(
        c("gray", "  浪费率: ") +
          c(wasteColor, `${pct(j.wasteRate)}`) +
          c("gray", `（作用域跳过 ${j.scopeSkipped} 份 / 扫到 ${j.loadedCount + j.scopeSkipped} 份）`),
      );
    }
    if (j.elapsedP50 != null) {
      // P2-3 验收：JIT 已是 fire-and-forget，这里的耗时**不进 TTFT**。
      // 但仍需盯 P95——它反映的是 JIT 队列可能拖到下一轮的程度。
      //
      // 不能用 fmtDuration：它把 0 当"缺失"渲染成 `?`（对 API 耗时是对的，
      // 0ms 的请求不存在）。但 JIT 命中缓存时 **0ms 是真实且常见的值**，
      // 渲染成 `?` 会让读者以为埋点没采到，把"快"误读成"坏"。
      const ms = (v: number) => `${Math.round(v)}ms`;
      L.push(
        c("gray", "  耗时: ") +
          `P50=${ms(j.elapsedP50)} P95=${ms(j.elapsedP95 ?? j.elapsedP50)}` +
          c("gray", "（fire-and-forget，不进 TTFT）"),
      );
    }
    const reasons = Object.entries(j.reasonCounts).sort((a, b) => b[1] - a[1]);
    if (reasons.length > 0) {
      L.push(c("gray", "  归因: ") + reasons.map(([r, n]) => `${r}×${n}`).join("  "));
    }
    if (j.oversized > 0) {
      L.push(c("yellow", `  ⚡ ${j.oversized} 份超大小告警阈值（内容未截断，见 /doctor）`));
    }
    if (j.failures > 0) {
      const codes = Object.entries(j.failureCodes).map(([k, n]) => `${k}×${n}`).join(" ");
      L.push(c("red", `  ✗ ${j.failures} 次读取失败: ${codes}`) + c("gray", "（ENOENT 已排除，均为真实错误）"));
    }
    for (const f of j.topFiles) {
      L.push(c("gray", `    · ${truncate(f.path, 60)} ${fmtBytes(f.bytes)} [${f.reason}]`));
    }
  }

  // §9.6：子代理执行 section（几成几败 + 串行/并行 + 每个 span 明细）
  if (d.subAgents && d.subAgents.total > 0) {
    const sa = d.subAgents;
    L.push("");
    const modeLabel: Record<SubAgentSummary["concurrency"], string> = {
      serial: "串行",
      parallel: "并行",
      mixed: "混合",
      single: "单个",
    };
    // 有失败标红，串行也是需要警觉的信号（可能是并发 bug）
    const headColor: Color = sa.failed > 0 ? "red" : sa.concurrency === "serial" && sa.total >= 2 ? "yellow" : "green";
    L.push(
      c("bold", "子代理执行:") +
        " " +
        c(headColor, `${sa.total} 个（${sa.succeeded} 成功 / ${sa.failed} 失败${sa.unknown > 0 ? ` / ${sa.unknown} 未知` : ""}）`) +
        c("gray", `  执行模式: ${modeLabel[sa.concurrency]}`),
    );
    if (sa.concurrency === "serial" && sa.total >= 2 && sa.serialEvidence) {
      L.push(c("yellow", `  ⚠ 串行排队铁证: ${sa.serialEvidence}`));
    }
    for (let i = 0; i < sa.spans.length; i++) {
      const s = sa.spans[i];
      const mark =
        s.status === "completed" ? c("green", "·") : s.status === "error" ? c("red", "✗") : c("yellow", "○");
      const statusText =
        s.status === "completed" ? "成功" : s.status === "error" ? "失败" : "未知";
      const dur = s.elapsedMs != null ? ` ${(s.elapsedMs / 1000).toFixed(1)}s` : "";
      const turns = s.turns != null ? ` ${s.turns}轮` : "";
      const gap = s.gapFromPrevMs != null && s.gapFromPrevMs >= 0 && s.gapFromPrevMs < 1000
        ? c("yellow", ` ←${s.gapFromPrevMs}ms`)
        : "";
      const desc = s.description ? c("gray", ` ${truncate(s.description, 64)}`) : "";
      L.push(`  ${mark} ${c("cyan", s.agentType)} [${statusText}]${dur}${turns}${gap}${desc}`);
    }
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

// ─────────────────────────── T12.5：Provider 聚合 ───────────────────────────

/**
 * 从 events.jsonl 事件列表聚合 per-provider 统计（导出供测试 + provider-health 使用）。
 *
 * P0-1（排查报告 Bug A 修复）—— 三个耗时指标的取数源分工：
 * - **TTFT（首字节/首内容延迟）**：取自 `StreamPhase("first_content").ttft_ms`。这是 lifecycle 层
 *   在每次 fetch 独立计算的"首个内容事件（content_block_delta，含思考/工具）延迟"，不含重试污染，
 *   也不受"仅可视文本才触发"的延迟污染。**弃用** `AfterModelRaw.ttft_ms`——后者来自 loop.ts 重试
 *   循环外只设一次的基准 + 仅首个"可视文本" chunk 触发，会把整轮生成耗时误计为首字节延迟
 *   （实测 idx=15 合成 102.3s vs 真实首 token 6.7s），导致 P50/P95 严重虚高、误导排查方向。
 * - **gen（模型生成耗时）**：取自 `RetryTelemetry("stream_completed").elapsedMs`（单次 fetch 从连接到
 *   流结束的纯耗时，自带 provider）。新增此维度让"慢在生成"这一主因显式可见。
 * - **avgLatencyMs（整轮 API 耗时）**：取自 `AfterModelRaw.elapsed_ms`（= apiDuration，含握手+生成+重试）。
 *   渲染时须标注为"整轮耗时"而非"网关握手延迟"，避免与 TTFT 混淆（Bug B）。
 *
 * first_content 事件只带 model 不带 provider，故先扫一遍 AfterModelRaw 建立 model→provider 映射，
 * 再用它把 first_content 的 ttft 归因到正确 provider（映射缺失时回退按 model 名启发式推断）。
 */
export function aggregateProviderStats(events: Array<{ event?: string; data?: Record<string, unknown> }>): ProviderDigestStats[] {
  const map = new Map<string, { requests: number; failed: number; timedOut: number; retried: number; totalLatencyMs: number; ttfts: number[]; gens: number[] }>();

  const ensure = (p: string) => {
    if (!map.has(p)) map.set(p, { requests: 0, failed: 0, timedOut: 0, retried: 0, totalLatencyMs: 0, ttfts: [], gens: [] });
    return map.get(p)!;
  };

  // 按 model 名启发式推断 provider（映射兜底：first_content 无 provider、AfterModelRaw 未覆盖该 model 时用）
  const inferProviderFromModel = (model: string): string =>
    model.includes("claude") ? "anthropic" : model ? "openai" : "unknown";

  // 第一遍：从 AfterModelRaw 建立 model→provider 映射（first_content 只带 model，需靠此归因）
  const modelToProvider = new Map<string, string>();
  for (const e of events) {
    if (e.event === "AfterModelRaw" && e.data) {
      const provider = (e.data.provider as string) || "";
      const model = (e.data.model as string) || "";
      if (provider && model && !modelToProvider.has(model)) modelToProvider.set(model, provider);
    }
  }
  const resolveProvider = (model: string): string =>
    modelToProvider.get(model) || inferProviderFromModel(model);

  // 第二遍：聚合各维度
  for (const e of events) {
    // AfterModelRaw：请求数 + 整轮耗时（avgLatencyMs 的来源）。不再从这里取 TTFT（被污染）。
    if (e.event === "AfterModelRaw" && e.data) {
      const provider = (e.data.provider as string) || "unknown";
      const stats = ensure(provider);
      stats.requests++;
      const elapsed = (e.data.elapsed_ms as number) || 0;
      stats.totalLatencyMs += elapsed;
    }
    // P0-1：TTFT 改从 StreamPhase("first_content") 收集——纯净的每次 fetch 首内容延迟
    if (e.event === "StreamPhase" && e.data && e.data.phase === "first_content") {
      const model = (e.data.model as string) || "";
      const provider = resolveProvider(model);
      const ttft = e.data.ttft_ms as number | undefined;
      if (ttft && ttft > 0) ensure(provider).ttfts.push(ttft);
    }
    // 从 RetryTelemetry 事件统计重试/超时 + 生成耗时（stream_completed.elapsedMs）
    if (e.event === "RetryTelemetry" && e.data) {
      const provider = (e.data.provider as string) || (e.data.model as string) || "unknown";
      const stats = ensure(provider);
      const type = e.data.type as string;
      if (type === "retry") {
        stats.retried++;
      } else if (type === "stream_idle_timeout" || type === "stream_content_progress_timeout" || type === "stream_overall_timeout") {
        stats.timedOut++;
      } else if (type === "529_dropped") {
        stats.failed++;
      } else if (type === "stream_completed") {
        // P0-1：纯生成耗时（单次 fetch 从连接到流结束）
        const gen = e.data.elapsedMs as number | undefined;
        if (gen && gen > 0) stats.gens.push(gen);
      }
    }
    // 从 TimeoutFired 事件补充超时计数
    if (e.event === "TimeoutFired" && e.data) {
      const model = (e.data.model as string) || "";
      // TimeoutFired 没有 provider 字段，用 model 推断
      if (model) {
        const stats = ensure(model.includes("deepseek") ? "openai" : model.includes("claude") ? "anthropic" : "unknown");
        stats.timedOut++;
      }
    }
  }

  const result: ProviderDigestStats[] = [];
  for (const [provider, stats] of map) {
    const timeoutRate = stats.requests > 0 ? stats.timedOut / stats.requests : 0;
    const sortedTtfts = stats.ttfts.sort((a, b) => a - b);
    const sortedGens = stats.gens.sort((a, b) => a - b);
    let warning: string | undefined;
    if (timeoutRate > 0.1) warning = `超时率 ${(timeoutRate * 100).toFixed(1)}% > 10%`;
    // T14.5：TTFT > 30s 标记 warning（现在基于纯净的 first_content TTFT，不再虚高误报）
    const ttftP95 = percentile(sortedTtfts, 0.95);
    if (ttftP95 && ttftP95 > 30000 && !warning) warning = `TTFT P95 ${(ttftP95 / 1000).toFixed(1)}s > 30s`;

    result.push({
      provider,
      requests: stats.requests,
      failed: stats.failed,
      timedOut: stats.timedOut,
      retried: stats.retried,
      avgLatencyMs: stats.requests > 0 ? Math.round(stats.totalLatencyMs / stats.requests) : 0,
      ttft_p50: percentile(sortedTtfts, 0.5),
      ttft_p95: ttftP95,
      ttft_p99: percentile(sortedTtfts, 0.99),
      gen_p50: percentile(sortedGens, 0.5),
      gen_p95: percentile(sortedGens, 0.95),
      gen_p99: percentile(sortedGens, 0.99),
      warning,
    });
  }
  return result;
}

// ─────────────────────── 第 5 批：JIT 上下文度量聚合 ───────────────────────

/**
 * 从 events.jsonl 聚合 JIT 上下文度量（导出供测试与上层脚本使用）。
 *
 * 消费的是 `app.ts:recordJitEvent` 打的 `jit_context` 事件。**未命中也打点**，
 * 所以这里的 `injections` 是分母、`hits` 是分子，命中率才有意义 ——
 * 只统计命中会让覆盖率永远看起来是 100%。
 *
 * 无事件时返回 `null`（而非零值对象）：区分「JIT 跑了但没命中」与
 * 「这个会话根本没有 JIT 数据」（老轨迹 / 配置关闭 / 全程没碰文件类工具）。
 * 渲染层据此决定整节是否显示 —— 显示一堆 0 会让人误以为 JIT 坏了。
 */
export function aggregateJitStats(
  events: Array<{ event?: string; data?: Record<string, unknown> }>,
): JitDigestStats | null {
  const jitEvents = events.filter((e) => e.event === "jit_context" && e.data);
  if (jitEvents.length === 0) return null;

  let hits = 0;
  let loadedCount = 0;
  let injectedBytes = 0;
  let cumulativeBytes = 0;
  let scopeSkipped = 0;
  let oversized = 0;
  let failures = 0;
  const failureCodes: Record<string, number> = {};
  const reasonCounts: Record<string, number> = {};
  const uniquePaths = new Set<string>();
  const elapsed: number[] = [];
  /** 按文件聚合字节：同一文件重载多次只保留最大值，避免 topFiles 把重载次数当体积 */
  const fileBytes = new Map<string, { bytes: number; reason: string }>();

  for (const e of jitEvents) {
    const d = e.data!;
    if (d.hit === true) hits++;
    scopeSkipped += num(d.scope_skipped);
    injectedBytes += num(d.injected_bytes);
    // 累积量取最大值而非末值：会话中途 /clear 或 compact 会 reset manager，
    // 末值可能被清零，峰值才代表"上下文最重时扛了多少"。
    cumulativeBytes = Math.max(cumulativeBytes, num(d.cumulative_bytes));

    const ms = num(d.elapsed_ms);
    if (ms >= 0 && d.elapsed_ms != null) elapsed.push(ms);

    const loaded = Array.isArray(d.loaded) ? (d.loaded as Array<Record<string, unknown>>) : [];
    loadedCount += loaded.length;
    for (const l of loaded) {
      const p = typeof l.path === "string" ? l.path : "(unknown)";
      const bytes = num(l.bytes);
      const reason = typeof l.reason === "string" ? l.reason : "unknown";
      uniquePaths.add(p);
      if (l.oversized === true) oversized++;
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
      const prev = fileBytes.get(p);
      if (!prev || bytes > prev.bytes) fileBytes.set(p, { bytes, reason });
    }

    const fails = Array.isArray(d.failures) ? (d.failures as Array<Record<string, unknown>>) : [];
    failures += fails.length;
    for (const f of fails) {
      const code = typeof f.code === "string" ? f.code : "UNKNOWN";
      failureCodes[code] = (failureCodes[code] ?? 0) + 1;
    }
  }

  const sortedElapsed = elapsed.slice().sort((a, b) => a - b);
  // 浪费率分母 = 扫到的带规则文件总数（命中的 + 因作用域跳过的）。
  // 用 injections 当分母是错的——那答的是另一个问题（触发中有多少次空手而归）。
  const scanned = loadedCount + scopeSkipped;
  const topFiles = [...fileBytes.entries()]
    .map(([path, v]) => ({ path, bytes: v.bytes, reason: v.reason }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5);

  return {
    injections: jitEvents.length,
    hits,
    hitRate: jitEvents.length > 0 ? hits / jitEvents.length : 0,
    loadedCount,
    uniqueFiles: uniquePaths.size,
    injectedBytes,
    cumulativeBytes,
    scopeSkipped,
    wasteRate: scanned > 0 ? scopeSkipped / scanned : 0,
    oversized,
    failures,
    failureCodes,
    reasonCounts,
    elapsedP50: percentile(sortedElapsed, 0.5),
    elapsedP95: percentile(sortedElapsed, 0.95),
    topFiles,
  };
}

/** 事件字段取数：非有限数字统一归 0，避免 undefined 参与算术得出 NaN 污染整节 */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 计算已排序数组的百分位数（导出供 provider-health 等模块共用，避免逻辑重复） */
export function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}
