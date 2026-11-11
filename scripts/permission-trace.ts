#!/usr/bin/env bun
/**
 * permission-trace —— 按会话追溯权限决策（trace × 审计 join + 覆盖度自检）
 *
 * ── 为什么一等公民是「覆盖度自检」而不是「分布报告」──
 *
 * B24 要答的是「交互式 ask 的批准率 / 误伤率」，这要求样本是**真的问过人**或
 * **管线真的拒绝过**的决策。而本机实测（2026-11-11）：带 key 的窗口内 100% 是
 * skip 档 allow —— 管线在 Step 8 早退，什么都没判。任何直接出分布的实现都会产出
 * 「100% allow」这种看起来绿、实则无信息的结果，而它一旦被当成事实引用，
 * 比不出数更糟。
 *
 * 所以本脚本先回答「这次窗口能不能出数」，答不了就以退出码 1 结束、
 * **一张分布表都不打印**。这是硬门，不是警告。
 *
 * ── 口径定义（改任何一条前先读这一段，否则读数的人会看错）──
 *
 * 1. 桶划分（`bucketOf`）：
 *      skipped —— `mode=dangerously-skip-permissions` 或 `step=skip`，管线未执行
 *      unknown —— `mode` 与 `step` 双缺，**无法判断**管线是否执行过（老轨迹埋点未落）
 *      judged  —— 其余，管线真的走到了某个判定步骤
 *    `unknown` 必须单列而不是并进 judged：并进去等于把「不知道」当成「判过了」。
 *    实测本机 36.9% 是 unknown（2026-10 的老轨迹），并进去会让分母整体错位。
 *
 * 2. 「有效样本」（`isEffectiveSample`）= **交互式决策**：
 *      `prompted=true`（轨迹侧）或 `confirm_via` 非空（轨迹侧）
 *      或 `confirm_source` 非空 / `user_confirmed=true`（审计侧）
 *    且不在 skipped 桶。
 *
 *    ⚠️ `outcome=deny` **刻意不算有效样本**，尽管「误伤率」看起来需要它。
 *    理由：本机 2,111 条 deny 里 1,322 是 forked（走调用方注入的 canUseTool，
 *    不经 PermissionChecker）、618 是 subagent —— 它们不是「管线问过人」的决策。
 *    把 deny 一律计入会让脚本以 751/30（或 2111/30）直接假通过，然后输出一张
 *    「100% 是 deny」的表，恰好是本方案要防的那类假绿。
 *    deny 单独作为**可抽样框**在第 3 层列出，它服务的是人工标注，不是自动率值。
 *
 * 3. 「决策」的分母默认 = judged + unknown 桶（即「非 skipped」），skip 档在
 *    分布表里单列一列并标注「管线未执行」——它不进主分母，也永不与主分母相加。
 *
 * 4. 「误伤」不做自动判定。脚本只给可抽样框（join 上的 deny + 拒绝成因 +
 *    resource），误伤率必须人标注：n=30 单人标注的置信区间本来就宽，
 *    自动化只会让这个数看起来比实际可信。
 *
 * 5. A1 的成因只认 reason 文本前缀「非交互模式下自动拒绝」+ 方括号标签；
 *    无标签的单列 unlabeled，**不猜**。
 *
 * ── 用法 ──
 *
 *   bun scripts/permission-trace.ts                     # 扫最近 7 天
 *   bun scripts/permission-trace.ts --days 30           # 指定窗口
 *   bun scripts/permission-trace.ts --session <id前缀>   # 单会话追溯
 *   bun scripts/permission-trace.ts --json              # 机器可读（供 northstar 消费）
 *
 *   `SID_CONFIG_DIR` / `SID_CODE_HOME` 与产品内其他组件同口径（经 resolvePaths 解析）。
 *
 * ── 退出码 ──
 *
 *   0 自检全过（第 2 / 3 层已输出）
 *   1 自检不过（只输出第 1 层覆盖度 + 缺口构成）
 *   2 用法错误
 *
 * CI / northstar 用退出码判，**不解析文本** —— 文本是给人看的，格式会变。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { resolvePaths } from "@sid-code/core/trace/digest.ts";

// ─────────────────────────── 阈值 ───────────────────────────

/**
 * 覆盖度自检阈值，全部集中在这里。
 *
 * 除 `minEffectiveSamples` 外，其余三个是按「本机 11-09 起已 100%」定的，
 * 是**回归护栏而非目标值** —— 它们红了说明键链路断了（#681 那种），
 * 而不是说明数据不够多。
 *
 * `minEffectiveSamples=30` 是唯一会因「样本少」而红的门槛：n=30 是 02 §1 Q5
 * 里单人标注的样本量，比这更少的比率没有解释价值。
 */
export const THRESHOLDS = {
  auditKeyCoverage: 0.9,
  traceKeyCoverage: 0.9,
  joinSuccessRate: 0.95,
  minEffectiveSamples: 30,
} as const;

// ─────────────────────────── 类型 ───────────────────────────

/** 权限决策的三个桶。`unknown` 不是「判过了」也不是「跳过了」，是「无法判断」。 */
export type DecisionBucket = "skipped" | "judged" | "unknown";

/** 轨迹侧一条 `PermissionDecision`（只取本案用得到的字段） */
export interface TraceDecision {
  /** 轨迹目录 id（resume 时 = 被恢复会话的旧 id） */
  sessionId: string;
  toolUseId?: string;
  tool: string;
  outcome: string;
  prompted: boolean;
  confirmVia?: string;
  executionContext: string;
  step?: string;
  mode?: string;
  reasonType?: string;
  timestamp?: string;
}

/** 审计侧一行（`AuditEntry` 的宽松投影：老行字段不全，一律 optional） */
export interface AuditRow {
  rawSessionId?: string;
  toolUseId?: string;
  tool: string;
  decision: string;
  reason?: string;
  resource?: string;
  confirmSource?: string;
  userConfirmed?: boolean;
  reasonType?: string;
  timestamp?: string;
}

/** 一天的键覆盖率计数。键覆盖率是**回归护栏**（链路现在断没断），不是历史完整度指标。 */
export interface DayCoverage {
  day: string;
  total: number;
  withKey: number;
}

export interface TraceIndex {
  decisions: TraceDecision[];
  /** `process_session_id` → 轨迹目录 id。resume 会话两侧 id 语义不同，join 前必须归一 */
  sessionIdMap: Map<string, string>;
  /** 真发生过 resume 的会话（供报告展示映射前后对照） */
  resumeMappings: Array<{ traceDir: string; processSessionId: string }>;
  total: number;
  withKey: number;
  sessionsScanned: number;
  /** 按 UTC 日期（`YYYY-MM-DD`）拆的键覆盖率，供「最近数据日」口径与按天明细用 */
  byDay: Map<string, DayCoverage>;
}

export interface AuditIndex {
  rows: AuditRow[];
  total: number;
  withKey: number;
  files: string[];
  byDay: Map<string, DayCoverage>;
}

export interface JoinResult {
  joined: Array<{ trace: TraceDecision; audit: AuditRow }>;
  /** 轨迹有、审计无。按 `execution_context` 区分预期（forked）与缺口（main / subagent） */
  traceOnly: TraceDecision[];
  /** 审计有、轨迹无。多为日志轮转把旧行挤掉 */
  auditOnly: AuditRow[];
  /** 审计侧缺键行数（按缺哪一侧分开记账，混在一起会看不出是哪个 key 没落） */
  auditNoKey: number;
  traceNoKey: number;
}

export interface SelfCheckItem {
  key: string;
  label: string;
  /** 实际值：覆盖率类是小数字，样本量类是整数 */
  value: number;
  threshold: number;
  passed: boolean;
  /** 人话说明「这个数是怎么来的」，红的时候能直接看出缺口在哪 */
  detail: string;
}

export interface SelfCheckResult {
  items: SelfCheckItem[];
  passed: boolean;
  effectiveSamples: number;
}

/** 一组 (mode, outcome, step) 计数。`skipped` 单独一个字段，永不与主分母相加。 */
export interface BucketCount {
  key: string;
  count: number;
}

export interface Report {
  window: { sinceIso: string | null; days: number | null; sessionPrefix: string | null };
  trace: { total: number; withKey: number; sessionsScanned: number };
  audit: { total: number; withKey: number; files: string[] };
  buckets: Record<DecisionBucket, number>;
  join: {
    joined: number;
    traceOnly: number;
    traceOnlyByContext: BucketCount[];
    auditOnly: number;
    auditNoKey: number;
    traceNoKey: number;
    joinSuccessRate: number;
  };
  resumeMappings: Array<{ traceDir: string; processSessionId: string }>;
  selfCheck: SelfCheckResult;
  /** 自检全过才填。不过时是 null —— 这样「有没有分布」本身就是结构性的，不靠人肉约定 */
  distribution: {
    byModeOutcomeStep: Array<{ mode: string; outcome: string; step: string; count: number }>;
    byTool: Array<{ tool: string; allow: number; deny: number; skipped: number }>;
    byReasonType: BucketCount[];
  } | null;
  /** 拒绝成因：只统计 join 上的 deny（审计侧有结论 + 轨迹侧有上下文） */
  denialBreakdown: {
    total: number;
    byReasonType: BucketCount[];
    byTextLabel: BucketCount[];
    /** 「非交互模式下自动拒绝」这一族的总数——`unlabeled` 的分母只能是它 */
    a1FamilyTotal: number;
    unlabeled: number;
    samples: Array<{ tool: string; reasonHead: string; resource?: string }>;
  } | null;
}

// ─────────────────────────── 读轨迹 ───────────────────────────

/** `PermissionDecision` 的桶划分。见文件头注释第 1 条。 */
export function bucketOf(d: Pick<TraceDecision, "mode" | "step">): DecisionBucket {
  if (d.mode === "dangerously-skip-permissions" || d.step === "skip") return "skipped";
  // 双缺不是「判过了」：老轨迹根本没落这两个字段，管线走没走过无从判断
  if (!d.mode && !d.step) return "unknown";
  return "judged";
}

/** 该决策是否是「交互式样本」。见文件头注释第 2 条。 */
export function isEffectiveSample(
  trace: Pick<TraceDecision, "prompted" | "confirmVia" | "mode" | "step">,
  audit?: Pick<AuditRow, "confirmSource" | "userConfirmed">,
): boolean {
  if (bucketOf(trace) === "skipped") return false;
  if (trace.prompted) return true;
  if (trace.confirmVia) return true;
  if (audit?.confirmSource) return true;
  if (audit?.userConfirmed) return true;
  return false;
}

function toStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * 读轨迹：`sessions/<dir>/events.jsonl`。
 *
 * 只关心两种事件：`SessionStart`（拿 resume 映射）与 `PermissionDecision`。
 * 其余行连 JSON.parse 都不做 —— 本机 985 个会话、单文件可达数万行，
 * 全解析一遍要多花一个数量级的时间。
 */
export function readTraceIndex(
  sessionsDir: string,
  opts: { sinceMs?: number; sessionPrefix?: string } = {},
): TraceIndex {
  const index: TraceIndex = {
    decisions: [],
    sessionIdMap: new Map(),
    resumeMappings: [],
    total: 0,
    withKey: 0,
    sessionsScanned: 0,
    byDay: new Map(),
  };
  if (!existsSync(sessionsDir)) return index;

  const sinceIso = opts.sinceMs === undefined ? null : new Date(opts.sinceMs).toISOString();

  for (const entry of readdirSync(sessionsDir)) {
    if (entry.startsWith(".")) continue;
    const dir = join(sessionsDir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const evPath = join(dir, "events.jsonl");
    if (!existsSync(evPath)) continue;

    // 整目录的最后写入时间早于窗口起点 → 里面不可能有窗口内的事件。
    // resume 会把新事件追加进旧目录，mtime 因此是正确的「最新写入」判据。
    if (sinceIso) {
      try {
        if (statSync(evPath).mtimeMs < Date.parse(sinceIso)) continue;
      } catch {
        continue;
      }
    }

    const dirId = basename(dir);

    let raw: string;
    try {
      raw = readFileSync(evPath, "utf8");
    } catch {
      continue;
    }
    index.sessionsScanned++;

    // 目录 id 不匹配**不能**直接跳过整个目录：`--session <新进程id>` 要命中的是
    // resume 会话 SessionStart 里的 `process_session_id`，而 resume 的轨迹目录名
    // 是旧 id。先按目录名判，读到 SessionStart 时再按 process_session_id 补判，
    // 否则 `--session` 会对着真实存在的会话静默返回空。
    let dirMatched = !opts.sessionPrefix || dirId.startsWith(opts.sessionPrefix);

    for (const line of raw.split("\n")) {
      if (!line) continue;
      // 两个都认才 parse：字符串预筛比 JSON.parse 便宜一个数量级
      if (!line.includes('"PermissionDecision"') && !line.includes('"SessionStart"')) continue;

      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const kind = ev?.event;
      const data = ev?.data ?? {};
      const ts = toStr(ev?.timestamp);

      if (kind === "SessionStart") {
        const processSessionId = toStr(data.process_session_id);
        const resumedFrom = toStr(data.resumed_from);
        if (processSessionId) {
          index.sessionIdMap.set(processSessionId, dirId);
          if (resumedFrom) {
            index.resumeMappings.push({ traceDir: dirId, processSessionId });
          }
          if (opts.sessionPrefix && processSessionId.startsWith(opts.sessionPrefix)) {
            dirMatched = true;
          }
        }
        continue;
      }

      if (kind !== "PermissionDecision") continue;
      if (!dirMatched) continue;
      if (sinceIso && ts && ts < sinceIso) continue;

      index.total++;
      const toolUseId = toStr(data.tool_use_id);
      if (toolUseId) index.withKey++;
      const day = ts ? ts.slice(0, 10) : "<无时间戳>";
      const dc = index.byDay.get(day) ?? { day, total: 0, withKey: 0 };
      dc.total++;
      if (toolUseId) dc.withKey++;
      index.byDay.set(day, dc);
      index.decisions.push({
        sessionId: dirId,
        toolUseId,
        tool: toStr(data.tool_name) ?? "<未知>",
        outcome: toStr(data.outcome) ?? "unknown",
        prompted: data.prompted === true,
        confirmVia: toStr(data.confirm_via),
        executionContext: toStr(data.execution_context) ?? "<未知>",
        step: toStr(data.step),
        mode: toStr(data.mode),
        reasonType: toStr(data.reason_type),
        timestamp: ts,
      });
    }
  }

  return index;
}

// ─────────────────────────── 读审计 ───────────────────────────

/**
 * 读审计：`logs/permissions-audit*.log*` 全部代数（含 `-retained.log` 若存在）。
 *
 * 为什么用通配而不是固定文件名：主日志只保留 1 代（`.log` + `.log.1`），
 * B21 的保留日志还有自己的代数。写死文件名的话，跨代窗口会缺一半数据，
 * 而缺的那一半恰好是最旧的（最可能出现 deny 的那批）。
 */
export function readAuditEntries(
  logsDir: string,
  opts: { sinceMs?: number; sessionPrefix?: string; sessionIdMap?: Map<string, string> } = {},
): AuditIndex {
  const out: AuditIndex = { rows: [], total: 0, withKey: 0, files: [], byDay: new Map() };
  if (!existsSync(logsDir)) return out;

  const sinceIso = opts.sinceMs === undefined ? null : new Date(opts.sinceMs).toISOString();
  let names: string[];
  try {
    names = readdirSync(logsDir).filter((n) => /^permissions-audit.*\.log/.test(n));
  } catch {
    return out;
  }
  names.sort();

  const map = opts.sessionIdMap;

  for (const name of names) {
    const p = join(logsDir, name);
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    out.files.push(name);

    for (const line of raw.split("\n")) {
      if (!line) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = toStr(e.timestamp);
      if (sinceIso && ts && ts < sinceIso) continue;

      const rawSessionId = toStr(e.session_id);
      const toolUseId = toStr(e.tool_use_id);

      // `--session` 过滤在归一之后做：resume 会话的审计行盖的是**新进程 id**，
      // 用旧 id 前缀过滤会静默漏掉它们（这正是 L3(a) 那个缺陷的表现形式）。
      if (opts.sessionPrefix) {
        const norm = rawSessionId ? (map?.get(rawSessionId) ?? rawSessionId) : undefined;
        const hit =
          (rawSessionId?.startsWith(opts.sessionPrefix) ?? false) ||
          (norm?.startsWith(opts.sessionPrefix) ?? false);
        if (!hit) continue;
      }

      out.total++;
      if (rawSessionId && toolUseId) out.withKey++;
      const day = ts ? ts.slice(0, 10) : "<无时间戳>";
      const dc = out.byDay.get(day) ?? { day, total: 0, withKey: 0 };
      dc.total++;
      if (rawSessionId && toolUseId) dc.withKey++;
      out.byDay.set(day, dc);
      out.rows.push({
        rawSessionId,
        toolUseId,
        tool: toStr(e.tool) ?? "<未知>",
        decision: toStr(e.decision) ?? "unknown",
        reason: toStr(e.reason),
        resource: toStr(e.resource),
        confirmSource: toStr(e.confirm_source),
        userConfirmed: e.user_confirmed === true,
        reasonType: toStr(e.decisionReason?.type),
        timestamp: ts,
      });
    }
  }

  return out;
}

// ─────────────────────────── join ───────────────────────────

/**
 * 以 `(归一后 session_id, tool_use_id)` 为键做双向匹配。
 *
 * 归一这一步缺了，resume 会话的审计行会全部落进 `audit_only`，
 * 表现为「审计有 1,200 行、join 成功 0 行」——而键其实一个好都没缺。
 */
export function joinDecisions(trace: TraceIndex, audit: AuditIndex): JoinResult {
  const norm = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined;
    return trace.sessionIdMap.get(raw) ?? raw;
  };

  const traceKeyed = new Map<string, TraceDecision>();
  for (const d of trace.decisions) {
    if (!d.toolUseId) continue;
    traceKeyed.set(`${d.sessionId}\u0000${d.toolUseId}`, d);
  }

  const seenAudit = new Set<string>();
  const result: JoinResult = {
    joined: [],
    traceOnly: [],
    auditOnly: [],
    auditNoKey: 0,
    traceNoKey: 0,
  };

  for (const d of trace.decisions) {
    if (!d.toolUseId) result.traceNoKey++;
  }

  for (const row of audit.rows) {
    const sid = norm(row.rawSessionId);
    if (!sid || !row.toolUseId) {
      result.auditNoKey++;
      continue;
    }
    const key = `${sid}\u0000${row.toolUseId}`;
    // 同一 (session, tool_use_id) 在审计里可能有多行（「为什么要问」+「问的结果」）。
    // 只保留第一行的 join 关系，避免同一个轨迹决策被算成多次——
    // 后续行仍然参与 denialBreakdown，那里统计的是审计行而不是决策。
    const traceDecision = traceKeyed.get(key);
    if (traceDecision) {
      if (!seenAudit.has(key)) {
        result.joined.push({ trace: traceDecision, audit: row });
        seenAudit.add(key);
      }
    } else {
      result.auditOnly.push(row);
    }
  }

  for (const [key, d] of traceKeyed) {
    if (!seenAudit.has(key)) result.traceOnly.push(d);
  }

  return result;
}

// ─────────────────────────── 自检 ───────────────────────────

/**
 * 最近 N 个**自然日**（从最新数据日往前推）的键覆盖率。
 *
 * **为什么不是整个窗口**：键覆盖率是**回归护栏**，它要答的是「键链路现在断没断」。
 * 用整个窗口算，只要窗口跨过任何一次「埋点上线之前」的历史数据（本机是 #681 的
 * 11-09 合入点），覆盖率就会被历史数据永久拖到阈值以下 —— 而恒红的门禁等于没有门禁
 * （仓库已有同源教训：`typecheck:gate` 不裸跑 `tsc --noEmit` 也是这个理由）。
 *
 * **为什么是「自然日」而不是「最近 N 个数据日」**：后者在数据不连续时会把很久以前的
 * 那一天也拖进来（今天 + 半年前的某天，仍然只是「2 个数据日」）。实测踩到过：
 * 一条跨 6 天的夹具里，历史日 100% 无键 + 今天 100% 有键，「最近 2 个数据日」
 * 算出 23%，护栏照样恒红。改成自然日窗口后，跨出 N 天的那部分才真的不参与判据。
 *
 * 取 N 天而不是 1 天：单日样本可能极小（刚过午夜只有几条），覆盖率会在
 * 0% / 100% 之间剧烈抖动。
 */
export function recentDayCoverage(
  byDay: Map<string, DayCoverage>,
  nDays = 3,
): { coverage: number; days: string[]; total: number; withKey: number } {
  const valid = [...byDay.values()].filter((d) => d.day !== "<无时间戳>");
  if (valid.length === 0) return { coverage: 0, days: [], total: 0, withKey: 0 };

  const latestDay = valid.reduce((a, b) => (a.day > b.day ? a : b)).day;
  const latestMs = Date.parse(`${latestDay}T00:00:00.000Z`);
  const floorDay = new Date(latestMs - (nDays - 1) * 86400_000).toISOString().slice(0, 10);

  const picked = valid.filter((d) => d.day >= floorDay);
  let total = 0;
  let withKey = 0;
  for (const d of picked) {
    total += d.total;
    withKey += d.withKey;
  }
  return {
    coverage: total === 0 ? 0 : withKey / total,
    days: picked.map((d) => d.day).sort(),
    total,
    withKey,
  };
}

/**
 * 覆盖度自检。**先算先判**，结果决定要不要出分布。
 *
 * 前三条是回归护栏（键链路断没断），第四条是「这次窗口能不能出数」。
 */
export function runSelfCheck(
  trace: TraceIndex,
  audit: AuditIndex,
  join: JoinResult,
): SelfCheckResult {
  const recentAudit = recentDayCoverage(audit.byDay);
  const recentTrace = recentDayCoverage(trace.byDay);
  const auditCoverage = recentAudit.coverage;
  const traceCoverage = recentTrace.coverage;
  const joinRate = audit.withKey === 0 ? 0 : join.joined.length / audit.withKey;

  const auditBySession = new Map<string, AuditRow>();
  for (const row of audit.rows) {
    const sid = row.rawSessionId
      ? (trace.sessionIdMap.get(row.rawSessionId) ?? row.rawSessionId)
      : undefined;
    if (!sid || !row.toolUseId) continue;
    auditBySession.set(`${sid}\u0000${row.toolUseId}`, row);
  }

  let effective = 0;
  for (const d of trace.decisions) {
    const auditRow = d.toolUseId
      ? auditBySession.get(`${d.sessionId}\u0000${d.toolUseId}`)
      : undefined;
    if (isEffectiveSample(d, auditRow)) effective++;
  }

  // 窗口整体值只作参考写进 detail：它与判据值的差额就是「窗口里混进了多少埋点上线前的历史」
  const auditWindowCov = audit.total === 0 ? 0 : audit.withKey / audit.total;
  const traceWindowCov = trace.total === 0 ? 0 : trace.withKey / trace.total;
  const windowNote = (recent: { total: number }, windowCov: number, all: number): string =>
    recent.total === all ? "" : `；窗口整体 ${pct(windowCov)}（含埋点上线前的历史行，不参与判据）`;

  const items: SelfCheckItem[] = [
    {
      key: "auditKeyCoverage",
      label: "键覆盖率（审计）",
      value: auditCoverage,
      threshold: THRESHOLDS.auditKeyCoverage,
      passed: auditCoverage >= THRESHOLDS.auditKeyCoverage,
      detail:
        `最近 ${recentAudit.days.length} 个数据日 ${audit.withKey}/${audit.total} 行带 session_id+tool_use_id` +
        windowNote(recentAudit, auditWindowCov, audit.total),
    },
    {
      key: "traceKeyCoverage",
      label: "键覆盖率（轨迹）",
      value: traceCoverage,
      threshold: THRESHOLDS.traceKeyCoverage,
      passed: traceCoverage >= THRESHOLDS.traceKeyCoverage,
      detail:
        `最近 ${recentTrace.days.length} 个数据日 ${trace.withKey}/${trace.total} 条带 tool_use_id` +
        windowNote(recentTrace, traceWindowCov, trace.total),
    },
    {
      key: "joinSuccessRate",
      label: "join 成功率",
      value: joinRate,
      threshold: THRESHOLDS.joinSuccessRate,
      passed: joinRate >= THRESHOLDS.joinSuccessRate,
      detail: `${join.joined.length}/${audit.withKey} 条审计带键行命中轨迹`,
    },
    {
      key: "effectiveSamples",
      label: "有效样本量（交互式）",
      value: effective,
      threshold: THRESHOLDS.minEffectiveSamples,
      passed: effective >= THRESHOLDS.minEffectiveSamples,
      detail: `prompted/confirm_source 且非 skip 档的决策 ${effective} 条`,
    },
  ];

  return { items, passed: items.every((i) => i.passed), effectiveSamples: effective };
}

// ─────────────────────────── 分布 ───────────────────────────

function bump<K>(m: Map<K, number>, k: K, n = 1): void {
  m.set(k, (m.get(k) ?? 0) + n);
}

/** A1 的文本标签：只认 prefix 之后紧跟的方括号，且标签字符集收窄。 */
const A1_PREFIX = "非交互模式下自动拒绝";
const A1_TAG_RE = /(?:^|[:\s])\[([a-z][a-z0-9:_-]{0,40})\]/;

/**
 * 从 deny 的 reason 里切 A1 成因标签。
 *
 * 为什么必须收窄字符集：命令原文里也带方括号（实测切出过 `[group, cmd, claim]`
 * 和 `[:-2]` 这种垃圾标签）。宽匹配会让「标签分布」这张表全是噪声，
 * 而它的唯一用途就是告诉人「拒绝都是因为什么」。
 */
export function extractDenialLabel(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const head = reason.slice(0, 80);
  const m = A1_TAG_RE.exec(head);
  return m?.[1];
}

function sortedEntries(m: Map<string, number>): BucketCount[] {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
}

export function buildDistribution(trace: TraceIndex): NonNullable<Report["distribution"]> {
  const modeOutcomeStep = new Map<string, number>();
  const byMode = new Map<string, { allow: number; deny: number; skipped: number }>();
  const byReason = new Map<string, number>();
  const byTool = new Map<string, { allow: number; deny: number; skipped: number }>();

  // 分布建立在**全部轨迹决策**上（不是只有 join 上的），因为 join 只覆盖带键的那部分；
  // 用 join 结果算分布会让「工具分布」这张表变成「带键子集」的分布，读数的人不会知道。
  for (const d of trace.decisions) {
    const mode = d.mode ?? "<缺>";
    const step = d.step ?? "<缺>";
    const key = `${mode}\u0000${d.outcome}\u0000${step}`;
    bump(modeOutcomeStep, key);

    if (!byMode.has(mode)) byMode.set(mode, { allow: 0, deny: 0, skipped: 0 });
    const mc = byMode.get(mode)!;
    if (bucketOf(d) === "skipped") mc.skipped++;
    else if (d.outcome === "deny") mc.deny++;
    else mc.allow++;

    if (!byTool.has(d.tool)) byTool.set(d.tool, { allow: 0, deny: 0, skipped: 0 });
    const tc = byTool.get(d.tool)!;
    if (bucketOf(d) === "skipped") tc.skipped++;
    else if (d.outcome === "deny") tc.deny++;
    else tc.allow++;

    bump(byReason, d.reasonType ?? "<缺>");
  }

  return {
    byModeOutcomeStep: [...modeOutcomeStep.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, count]) => {
        const [mode, outcome, step] = k.split("\u0000");
        return { mode, outcome, step, count };
      }),
    byTool: [...byTool.entries()]
      .sort(
        (a, b) => b[1].allow + b[1].deny + b[1].skipped - (a[1].allow + a[1].deny + a[1].skipped),
      )
      .map(([tool, c]) => ({ tool, ...c })),
    byReasonType: sortedEntries(byReason),
  };
}

/**
 * 拒绝成因：只统计 **join 上** 的 deny。
 *
 * 为什么要 join 而不是直接数审计的 deny：审计侧 deny 没有 `decisionReason` 之外的
 * 上下文（没有 mode/step/execution_context），单看它分不出「forked 的注入拒绝」
 * 和「主循环的路径拒绝」。join 之后才有轨迹侧的属性可切。
 */
export function buildDenialBreakdown(
  join: JoinResult,
  audit: AuditIndex,
  trace: TraceIndex,
): NonNullable<Report["denialBreakdown"]> {
  const joinKeys = new Set<string>();
  for (const { trace: t } of join.joined) {
    if (t.toolUseId) joinKeys.add(`${t.sessionId}\u0000${t.toolUseId}`);
  }

  const byReasonType = new Map<string, number>();
  const byTextLabel = new Map<string, number>();
  const samples: Array<{ tool: string; reasonHead: string; resource?: string }> = [];
  let total = 0;
  let a1FamilyTotal = 0;
  let unlabeled = 0;

  for (const row of audit.rows) {
    if (row.decision !== "deny") continue;
    const sid = row.rawSessionId
      ? (trace.sessionIdMap.get(row.rawSessionId) ?? row.rawSessionId)
      : undefined;
    if (!sid || !row.toolUseId) continue;
    if (!joinKeys.has(`${sid}\u0000${row.toolUseId}`)) continue;

    total++;
    bump(byReasonType, row.reasonType ?? "<缺>");
    const label = extractDenialLabel(row.reason);
    const isA1Family = row.reason?.startsWith(A1_PREFIX) ?? false;
    // 只有「非交互模式下自动拒绝」这一族才谈得上「有没有标签」；
    // pathValidation 之类的 deny 本来就没有标签概念，把它们算成 unlabeled
    // 会让不可解析率凭空翻倍。
    if (isA1Family) a1FamilyTotal++;
    if (label) {
      bump(byTextLabel, label);
    } else if (isA1Family) {
      unlabeled++;
    }
    if (samples.length < 10) {
      samples.push({
        tool: row.tool,
        reasonHead: (row.reason ?? "").slice(0, 90),
        resource: row.resource,
      });
    }
  }

  return {
    total,
    byReasonType: sortedEntries(byReasonType),
    byTextLabel: sortedEntries(byTextLabel),
    a1FamilyTotal,
    unlabeled,
    samples,
  };
}

// ─────────────────────────── 组装 ───────────────────────────

export interface BuildOptions {
  sessionsDir: string;
  logsDir: string;
  days?: number;
  sessionPrefix?: string;
  nowMs?: number;
}

export function buildReport(opts: BuildOptions): Report {
  const nowMs = opts.nowMs ?? Date.now();
  const sinceMs = opts.days === undefined ? undefined : nowMs - opts.days * 86400_000;

  const trace = readTraceIndex(opts.sessionsDir, { sinceMs, sessionPrefix: opts.sessionPrefix });
  const audit = readAuditEntries(opts.logsDir, {
    sinceMs,
    sessionPrefix: opts.sessionPrefix,
    sessionIdMap: trace.sessionIdMap,
  });
  const join = joinDecisions(trace, audit);
  const selfCheck = runSelfCheck(trace, audit, join);

  const buckets: Record<DecisionBucket, number> = { skipped: 0, judged: 0, unknown: 0 };
  for (const d of trace.decisions) buckets[bucketOf(d)]++;

  const traceOnlyByContext = new Map<string, number>();
  for (const d of join.traceOnly) bump(traceOnlyByContext, d.executionContext);

  return {
    window: {
      sinceIso: sinceMs === undefined ? null : new Date(sinceMs).toISOString(),
      days: opts.days ?? null,
      sessionPrefix: opts.sessionPrefix ?? null,
    },
    trace: { total: trace.total, withKey: trace.withKey, sessionsScanned: trace.sessionsScanned },
    audit: { total: audit.total, withKey: audit.withKey, files: audit.files },
    buckets,
    join: {
      joined: join.joined.length,
      traceOnly: join.traceOnly.length,
      traceOnlyByContext: sortedEntries(traceOnlyByContext),
      auditOnly: join.auditOnly.length,
      auditNoKey: join.auditNoKey,
      traceNoKey: join.traceNoKey,
      joinSuccessRate: audit.withKey === 0 ? 0 : join.joined.length / audit.withKey,
    },
    resumeMappings: trace.resumeMappings,
    selfCheck,
    distribution: selfCheck.passed ? buildDistribution(trace) : null,
    denialBreakdown: selfCheck.passed ? buildDenialBreakdown(join, audit, trace) : null,
  };
}

// ─────────────────────────── 渲染 ───────────────────────────

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function pad(s: string, n: number): string {
  // 中文字符在终端占两列，按显示宽度补空格而不是按字符数
  let w = 0;
  for (const ch of s) w += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return s + " ".repeat(Math.max(0, n - w));
}

export function renderReport(report: Report, opts: { noColor?: boolean } = {}): string {
  const L: string[] = [];
  const color = (code: string, s: string) => (opts.noColor ? s : `\x1b[${code}m${s}\x1b[0m`);
  const ok = (s: string) => color("32", s);
  const bad = (s: string) => color("31", s);
  const dim = (s: string) => color("2", s);

  // ── 第 1 层：覆盖度 ──
  L.push("═══ B24 权限决策追溯 · 覆盖度自检 ═══");
  const w = report.window;
  L.push(
    dim(
      `窗口：${w.days === null ? "全量" : `最近 ${w.days} 天（自 ${w.sinceIso}）`}` +
        (w.sessionPrefix ? `  会话前缀：${w.sessionPrefix}` : ""),
    ),
  );
  L.push(
    `扫描：${report.trace.sessionsScanned} 个会话轨迹 / ${report.trace.total} 条权限决策 / ` +
      `${report.audit.total} 行审计（${report.audit.files.length} 个文件）`,
  );
  L.push("");
  L.push("自检项：");
  for (const item of report.selfCheck.items) {
    const shown = item.key === "effectiveSamples" ? String(item.value) : pct(item.value);
    const need =
      item.key === "effectiveSamples" ? `阈值 ≥${item.threshold}` : `阈值 ≥${pct(item.threshold)}`;
    const mark = item.passed ? ok("✓") : bad("✗");
    L.push(`  ${mark} ${pad(item.label, 26)} ${pad(shown, 9)} ${dim(need)}   ${dim(item.detail)}`);
  }

  L.push("");
  L.push("分母构成（skip 档永不并入主分母）：");
  L.push(
    `  judged（管线判过）      ${report.buckets.judged}` +
      `    unknown（无法判断）  ${report.buckets.unknown}` +
      `    skipped（管线未执行） ${report.buckets.skipped}`,
  );

  if (report.join.traceOnly > 0 || report.join.auditOnly > 0 || report.join.auditNoKey > 0) {
    L.push("");
    L.push("join 缺口构成：");
    L.push(
      `  轨迹独有 ${report.join.traceOnly} 条（按执行路径：${
        report.join.traceOnlyByContext.map((c) => `${c.key} ${c.count}`).join(" / ") || "—"
      }）`,
    );
    L.push(
      dim("    · forked 属预期（走调用方注入的 canUseTool，不经 PermissionChecker，本就不写审计）"),
    );
    L.push(dim("    · main / subagent 属真缺口，需回源码查为什么没写审计"));
    L.push(`  审计独有 ${report.join.auditOnly} 条（多为日志轮转把旧行挤掉）`);
    L.push(`  缺键：审计 ${report.join.auditNoKey} 行 / 轨迹 ${report.join.traceNoKey} 条`);
  }

  if (report.resumeMappings.length > 0) {
    L.push("");
    L.push(
      `resume 会话（${report.resumeMappings.length} 个，审计侧盖的是新进程 id，join 前已按此归一）：`,
    );
    for (const m of report.resumeMappings.slice(0, 10)) {
      L.push(`  轨迹目录 ${m.traceDir}  ←  process_session_id ${m.processSessionId}`);
    }
    if (report.resumeMappings.length > 10) {
      L.push(dim(`  … 还有 ${report.resumeMappings.length - 10} 个`));
    }
  }

  // ── 自检没过：到此为止 ──
  if (!report.selfCheck.passed) {
    L.push("");
    const failed = report.selfCheck.items.filter((i) => !i.passed);
    L.push(bad("✗ 自检不过，拒绝输出分布表。"));
    for (const f of failed) {
      if (f.key === "effectiveSamples") {
        L.push(
          `  有效样本 ${f.value} / 阈值 ${f.threshold} —— ` +
            `窗口里没有足够的交互式决策（prompted / confirm_source），任何比率的分母都是噪声。`,
        );
        L.push(
          dim("  处置：用 --permission-mode default 或 acceptEdits 跑一段真实任务攒样本，") +
            dim("或把该指标标为「待观测（样本不可得）」。"),
        );
      } else {
        L.push(`  ${f.label} ${pct(f.value)} < 阈值 ${pct(f.threshold)} —— 键链路断了，先查埋点。`);
      }
    }
    return L.join("\n");
  }

  // ── 第 2 层：分布 ──
  const dist = report.distribution!;
  L.push("");
  L.push("═══ 分布（skip 档单列，永不并入主分母）═══");

  L.push("");
  L.push("按 mode × outcome × step（前 20）：");
  L.push(`  ${pad("mode", 30)} ${pad("outcome", 10)} ${pad("step", 12)} 数量`);
  for (const r of dist.byModeOutcomeStep.slice(0, 20)) {
    const mark =
      r.mode === "dangerously-skip-permissions" || r.step === "skip" ? dim(" [管线未执行]") : "";
    L.push(`  ${pad(r.mode, 30)} ${pad(r.outcome, 10)} ${pad(r.step, 12)} ${r.count}${mark}`);
  }

  L.push("");
  L.push("按工具（前 20）：");
  L.push(`  ${pad("tool", 34)} ${pad("allow", 8)} ${pad("deny", 8)} ${pad("skipped", 8)}`);
  for (const r of dist.byTool.slice(0, 20)) {
    L.push(
      `  ${pad(r.tool, 34)} ${pad(String(r.allow), 8)} ${pad(String(r.deny), 8)} ${pad(String(r.skipped), 8)}`,
    );
  }

  L.push("");
  L.push("按 reason_type：");
  for (const r of dist.byReasonType) {
    L.push(`  ${pad(r.key, 26)} ${r.count}`);
  }

  // ── 第 3 层：拒绝成因 ──
  const db = report.denialBreakdown!;
  L.push("");
  L.push("═══ 拒绝成因（仅 join 上的 deny，供人工抽样，不自动算误伤率）═══");
  if (db.total === 0) {
    L.push(dim("  窗口内 join 上的 deny 为 0 —— 没有可抽样的拒绝。"));
  } else {
    L.push(`  join 上的 deny：${db.total} 条`);
    L.push("");
    L.push("  按 decisionReason.type：");
    for (const r of db.byReasonType) L.push(`    ${pad(r.key, 26)} ${r.count}`);
    if (db.byTextLabel.length > 0) {
      L.push("");
      L.push("  按 A1 文本标签（reason 前缀「非交互模式下自动拒绝」+ 方括号）：");
      for (const r of db.byTextLabel) L.push(`    ${pad(r.key, 34)} ${r.count}`);
    }
    if (db.unlabeled > 0) {
      const denom = db.a1FamilyTotal;
      L.push("");
      L.push(
        dim(
          `  无标签（A1 族里切不出标签）：${db.unlabeled} / ${denom} = ${pct(db.unlabeled / Math.max(denom, 1))}` +
            ` —— 这部分只能靠读 reason 原文，脚本不猜。`,
        ),
      );
    }
    if (db.samples.length > 0) {
      L.push("");
      L.push("  抽样框（前 10 条，供人工判误伤）：");
      for (const s of db.samples) {
        L.push(
          `    [${s.tool}] ${s.reasonHead}${s.resource ? dim(`  ← ${s.resource.slice(0, 60)}`) : ""}`,
        );
      }
    }
  }

  return L.join("\n");
}

// ─────────────────────────── CLI ───────────────────────────

/** 本脚本认得的全部 flag。未识别的一律报错退出（不静默忽略）。 */
export const KNOWN_FLAGS = new Set(["--days", "--session", "--json"]);

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const unknown = [...flags].filter((f) => !KNOWN_FLAGS.has(f));
  if (unknown.length > 0) {
    process.stderr.write(
      `⚠ 未识别参数: ${unknown.join(" ")}\n可用参数: ${[...KNOWN_FLAGS].join(" ")}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const json = flags.has("--json");
  let days: number | undefined = 7;
  const daysIdx = args.indexOf("--days");
  if (daysIdx >= 0) {
    const raw = args[daysIdx + 1];
    if (!raw || !/^\d+$/.test(raw)) {
      process.stderr.write(`⚠ --days 需要一个正整数天数\n`);
      process.exitCode = 2;
      return;
    }
    days = parseInt(raw, 10);
  }
  const sessionIdx = args.indexOf("--session");
  const sessionPrefix = sessionIdx >= 0 ? args[sessionIdx + 1] : undefined;
  if (sessionIdx >= 0 && (!sessionPrefix || sessionPrefix.startsWith("--"))) {
    process.stderr.write(`⚠ --session 需要一个会话 id 或 id 前缀\n`);
    process.exitCode = 2;
    return;
  }

  const paths = resolvePaths();
  const report = buildReport({
    sessionsDir: paths.sessionsDir,
    logsDir: join(paths.root, "logs"),
    days,
    sessionPrefix,
  });

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(
      renderReport(report, { noColor: !process.stdout.isTTY || !!process.env.NO_COLOR }) + "\n",
    );
  }

  // 自检不过 → 1。**不是** 0：CI / northstar 靠退出码判「这次能不能出数」，
  // 返回 0 会让一个「拒绝出分布」的窗口看起来和成功出数一样。
  process.exitCode = report.selfCheck.passed ? 0 : 1;
}

// 只在被当脚本直接执行时跑 main：单测要 import 本文件读导出函数，
// 顶层调 main() 会让测试顺手把本机真实数据打进输出（trace-digest.ts 踩过同一个坑）。
if (import.meta.main) main();
