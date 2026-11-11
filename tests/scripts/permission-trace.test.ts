/**
 * B24 `scripts/permission-trace.ts` 回归门禁
 *
 * ## 治的是什么
 *
 * 这个脚本的一等公民是「覆盖度自检」，不是「分布报告」。所以本文件的重心不在
 * 「表长得对不对」，而在三条**假绿防线**：
 *
 *   1. **skip 档不进主分母** —— skip 是「管线在 Step 8 早退、什么都没判」。
 *      把它算进分布，等于把「没判过」计入「判对了」（本机实测 skip 占 49%，
 *      虚报出来的误伤率恒为 0%）。
 *   2. **deny 不算有效样本** —— 本机 2,111 条 deny 里 1,322 是 forked（走调用方注入的
 *      `canUseTool`，不经 PermissionChecker）、618 是 subagent。把 deny 一律计入
 *      「交互式样本」，脚本会以 2,111/30 假通过、然后输出一张「100% 是 deny」的表。
 *   3. **自检不过时必须一张分布表都不打印** —— 只打警告而继续出表，读的人看到的
 *      仍然是一份「正常报告」，和静默降级没有区别（同源教训：trace-digest 的
 *      `--health` 漏接时照样打单会话摘要）。
 *
 * 另有一条口径不是假绿问题、但同样必须锁住：**键覆盖率按「最近数据日」判，不按
 * 整个窗口判**。键覆盖率是回归护栏，窗口一旦跨过埋点上线日（本机 #681 的 11-09），
 * 整个窗口口径会被历史数据永久拖到阈值以下 —— 恒红的门禁等于没有门禁。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  bucketOf,
  buildDistribution,
  buildReport,
  extractDenialLabel,
  isEffectiveSample,
  joinDecisions,
  readAuditEntries,
  readTraceIndex,
  recentDayCoverage,
  renderReport,
  THRESHOLDS,
  KNOWN_FLAGS,
  type DayCoverage,
} from "../../scripts/permission-trace.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "permission-trace.ts");

// ─────────────────────────── 纯函数口径 ───────────────────────────

describe("bucketOf：三桶划分", () => {
  test("skipPermissions → skipped（管线在 Step 8 早退）", () => {
    expect(bucketOf({ mode: "dangerously-skip-permissions", step: "8-mode" })).toBe("skipped");
  });

  test("step=skip → skipped（不依赖 mode 也认）", () => {
    expect(bucketOf({ mode: undefined, step: "skip" })).toBe("skipped");
  });

  test("mode 与 step 双缺 → unknown，不是 judged", () => {
    // 这是本机 36.9% 的老轨迹（2026-10 埋点未落 mode/step）。
    // 归进 judged 等于把「无从判断」当成「判过了」，分母整体错位。
    expect(bucketOf({ mode: undefined, step: undefined })).toBe("unknown");
  });

  test("有 mode 或 step 之一 → judged", () => {
    expect(bucketOf({ mode: "default", step: "8-mode" })).toBe("judged");
    expect(bucketOf({ mode: "default", step: undefined })).toBe("judged");
    expect(bucketOf({ mode: undefined, step: "4" })).toBe("judged");
  });
});

describe("isEffectiveSample：有效样本 = 交互式决策", () => {
  const base = { prompted: false, confirmVia: undefined, mode: "default", step: "8-mode" };

  test("skip 档即便 prompted=true 也不算（skip 优先）", () => {
    // skip 档不会真的问人，但万一埋点串了，这条兜底必须挡住。
    expect(
      isEffectiveSample({ ...base, prompted: true, mode: "dangerously-skip-permissions" }),
    ).toBe(false);
  });

  test("prompted=true → 有效样本", () => {
    expect(isEffectiveSample({ ...base, prompted: true })).toBe(true);
  });

  test("confirm_via 非空 → 有效样本", () => {
    expect(isEffectiveSample({ ...base, confirmVia: "tui" })).toBe(true);
  });

  test("审计侧 confirm_source / user_confirmed → 有效样本", () => {
    expect(isEffectiveSample(base, { confirmSource: "user" })).toBe(true);
    expect(isEffectiveSample(base, { userConfirmed: true })).toBe(true);
  });

  test("★ outcome=deny 但没问过人 → **不算**有效样本（防 2,111/30 假通过）", () => {
    // 这个函数签名里根本没有 outcome，正是刻意的：deny 属于「抽样框」，
    // 不属于「交互式分母」。一旦有人在这里加 outcome 判断，这条会先红。
    expect(isEffectiveSample(base)).toBe(false);
    expect(isEffectiveSample(base, { confirmSource: undefined, userConfirmed: false })).toBe(false);
  });
});

describe("extractDenialLabel：A1 的文本标签切分", () => {
  test("标准注入标签能切出来", () => {
    expect(
      extractDenialLabel(
        "非交互模式下自动拒绝: [injection:obfuscated-flags] 命令包含带引号的 flag",
      ),
    ).toBe("injection:obfuscated-flags");
  });

  test("风险等级标签能切出来", () => {
    expect(extractDenialLabel("非交互模式下自动拒绝: [high] 危险命令需要确认")).toBe("high");
  });

  test("★ 命令原文里的方括号不会被误切（字符集收窄的判据）", () => {
    // 实测宽匹配切出过 `group, cmd, claim` 和 `:-2` 这类垃圾标签，
    // 而这张表的唯一用途是「拒绝都是因为什么」——噪声会让它彻底不可读。
    expect(
      extractDenialLabel("非交互模式下自动拒绝: 工具要求确认: 前缀 [group, cmd, claim] 不是标签"),
    ).toBeUndefined();
    expect(extractDenialLabel("非交互模式下自动拒绝: 工具要求确认: 后缀 [:-2]")).toBeUndefined();
  });

  test("无标签 reason → undefined（不猜）", () => {
    expect(extractDenialLabel('非交互模式下自动拒绝: 工具 "bash" 需要用户确认')).toBeUndefined();
    expect(extractDenialLabel(undefined)).toBeUndefined();
  });
});

describe("recentDayCoverage：最近数据日口径（护栏不跨埋点上线日）", () => {
  const day = (d: string, total: number, withKey: number): DayCoverage => ({
    day: d,
    total,
    withKey,
  });

  test("只取最近 N 天：历史的无键数据不参与判据", () => {
    const byDay = new Map<string, DayCoverage>([
      ["2026-11-04", day("2026-11-04", 1000, 0)],
      ["2026-11-08", day("2026-11-08", 1000, 50)],
      ["2026-11-09", day("2026-11-09", 1000, 1000)],
      ["2026-11-10", day("2026-11-10", 1000, 1000)],
      ["2026-11-11", day("2026-11-11", 500, 500)],
    ]);
    const r = recentDayCoverage(byDay, 3);
    expect(r.coverage).toBe(1);
    expect(r.days).toEqual(["2026-11-09", "2026-11-10", "2026-11-11"]);
    expect(r.total).toBe(2500);
  });

  test("最近一天小样本不会单独决定结果（取 N 天而不是 1 天）", () => {
    // 刚过午夜只有 2 条、恰好都不带键 —— 若只看一天就是 0%，但链路其实没断。
    const byDay = new Map<string, DayCoverage>([
      ["2026-11-10", day("2026-11-10", 1000, 1000)],
      ["2026-11-11", day("2026-11-11", 2, 0)],
    ]);
    const r = recentDayCoverage(byDay, 3);
    expect(r.coverage).toBeCloseTo(1000 / 1002, 6);
  });

  test("无数据日 → 0，不抛错", () => {
    expect(recentDayCoverage(new Map()).coverage).toBe(0);
  });
});

// ─────────────────────────── tmpdir 夹具 ───────────────────────────

interface TraceEventInput {
  event: string;
  sessionId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

function writeTrace(root: string, sessionDir: string, events: TraceEventInput[]): void {
  const dir = join(root, "trajectories", "sessions", sessionDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "events.jsonl"),
    events.map((e) => JSON.stringify({ ...e, session_id: e.sessionId })).join("\n") + "\n",
  );
}

function writeAudit(
  root: string,
  rows: Record<string, unknown>[],
  name = "permissions-audit.log",
): void {
  const dir = join(root, "logs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const pd = (sessionId: string, ts: string, data: Record<string, unknown>): TraceEventInput => ({
  event: "PermissionDecision",
  sessionId,
  timestamp: ts,
  data,
});

/**
 * 主夹具：四类 join 结果 + resume 映射 + forked 独有，一次全造出来。
 *
 *   ses-A（main，非 resume）  tu-a1 / tu-a2，审计各有对应行 → joined ×2
 *   ses-B（resume）          目录名 B_old，审计盖的是 B_new → resume 归一后 joined ×1
 *   ses-A 的 forked 行        tu-f1，审计没有 → traceOnly(forked)，属预期
 *   审计侧 tu-x1              轨迹里没有 → auditOnly（轮转挤出）
 *   审计侧一行无键             → auditNoKey
 */
const A = "20261109-aaaa";
const B_OLD = "20261110-bbbb";
const B_NEW = "20261110-cccc";
const NOW = "2026-11-11T10:00:00.000Z";

function buildMainFixture(root: string): void {
  writeTrace(root, A, [
    {
      event: "SessionStart",
      sessionId: A,
      timestamp: NOW,
      data: { model: "x", trace_schema_version: 2 },
    },
    // 交互式：真问过人
    pd(A, NOW, {
      tool_name: "bash",
      outcome: "deny",
      prompted: true,
      confirm_via: "tui",
      execution_context: "main",
      step: "8-mode",
      mode: "default",
      tool_use_id: "tu-a1",
      reason_type: "dangerousCommand",
    }),
    // 普通放行：不是有效样本
    pd(A, NOW, {
      tool_name: "read",
      outcome: "allow",
      prompted: false,
      execution_context: "main",
      step: "10",
      mode: "default",
      tool_use_id: "tu-a2",
    }),
    // forked：不经 PermissionChecker，不写审计（预期缺口）
    pd(A, NOW, {
      tool_name: "edit",
      outcome: "deny",
      prompted: false,
      execution_context: "forked",
      step: "forked",
      mode: "always-allow",
      tool_use_id: "tu-f1",
    }),
  ]);

  writeTrace(root, B_OLD, [
    {
      event: "SessionStart",
      sessionId: B_OLD,
      timestamp: NOW,
      // resume：目录名是旧 id，本进程是新 id
      data: { model: "x", resumed_from: B_OLD, process_session_id: B_NEW },
    },
    pd(B_OLD, NOW, {
      tool_name: "write",
      outcome: "allow",
      prompted: false,
      execution_context: "main",
      step: "8-mode",
      mode: "default",
      tool_use_id: "tu-b1",
    }),
  ]);

  writeAudit(root, [
    {
      timestamp: NOW,
      type: "tool_use",
      tool: "bash",
      resource: "rm -rf /tmp/x",
      decision: "deny",
      reason: "非交互模式下自动拒绝: [injection:obfuscated-flags] 命令包含带引号的 flag",
      session_id: A,
      tool_use_id: "tu-a1",
      decisionReason: { type: "other" },
      confirm_source: "user",
      user_confirmed: true,
    },
    {
      timestamp: NOW,
      type: "tool_use",
      tool: "read",
      resource: "/tmp/a",
      decision: "allow",
      session_id: A,
      tool_use_id: "tu-a2",
    },
    // resume：审计盖的是**新进程 id**（B19 的既有行为），按它 join 才连得上
    {
      timestamp: NOW,
      type: "tool_use",
      tool: "write",
      resource: "/tmp/b",
      decision: "allow",
      session_id: B_NEW,
      tool_use_id: "tu-b1",
    },
    // 轨迹里没有 → auditOnly
    {
      timestamp: NOW,
      type: "tool_use",
      tool: "bash",
      resource: "/tmp/gone",
      decision: "allow",
      session_id: "20261101-old",
      tool_use_id: "tu-x1",
    },
    // 无键 → auditNoKey
    { timestamp: NOW, type: "tool_use", tool: "grep", decision: "deny", reason: "路径不在白名单" },
  ]);
}

describe("joinDecisions：四类 join 结果", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "permission-trace-"));
    buildMainFixture(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("★ resume 会话能被 join 上（审计侧盖新进程 id，归一后可查）", () => {
    const trace = readTraceIndex(join(root, "trajectories", "sessions"));
    const audit = readAuditEntries(join(root, "logs"), { sessionIdMap: trace.sessionIdMap });
    const joined = joinDecisions(trace, audit);

    expect(joined.joined.map((j) => j.trace.toolUseId).sort()).toEqual(["tu-a1", "tu-a2", "tu-b1"]);
    // 归一确实做了：审计行的 rawSessionId 是新 id，轨迹侧是旧目录名
    const b = joined.joined.find((j) => j.trace.toolUseId === "tu-b1")!;
    expect(b.trace.sessionId).toBe(B_OLD);
    expect(b.audit.rawSessionId).toBe(B_NEW);
  });

  test("resumeMappings 记下映射前后对照（报告要给读者看）", () => {
    const trace = readTraceIndex(join(root, "trajectories", "sessions"));
    expect(trace.resumeMappings).toEqual([{ traceDir: B_OLD, processSessionId: B_NEW }]);
  });

  test("forked 行落进 traceOnly，且按执行路径分得开", () => {
    const trace = readTraceIndex(join(root, "trajectories", "sessions"));
    const audit = readAuditEntries(join(root, "logs"), { sessionIdMap: trace.sessionIdMap });
    const joined = joinDecisions(trace, audit);
    expect(joined.traceOnly.map((d) => d.executionContext)).toEqual(["forked"]);
  });

  test("审计独有与缺键分开记账（混在一起看不出是哪个 key 没落）", () => {
    const trace = readTraceIndex(join(root, "trajectories", "sessions"));
    const audit = readAuditEntries(join(root, "logs"), { sessionIdMap: trace.sessionIdMap });
    const joined = joinDecisions(trace, audit);
    expect(joined.auditOnly.map((r) => r.toolUseId)).toEqual(["tu-x1"]);
    expect(joined.auditNoKey).toBe(1);
    expect(joined.traceNoKey).toBe(0);
  });

  test("--session 能按轨迹目录名前缀命中", () => {
    const trace = readTraceIndex(join(root, "trajectories", "sessions"), { sessionPrefix: A });
    expect(trace.total).toBe(3);
  });

  test("--session 也能按 resume 的新进程 id 命中（否则会对真实会话静默返回空）", () => {
    const trace = readTraceIndex(join(root, "trajectories", "sessions"), {
      sessionPrefix: B_NEW.slice(0, 12),
    });
    expect(trace.total).toBe(1);
  });
});

// ─────────────────────────── 自检门与分布分层 ───────────────────────────

/**
 * 造一个「两侧键齐全、决策全是交互式」的数据集。
 *
 * `n` 直接对应有效样本量，所以它同时是「阈值边界」测试的旋钮：
 * n=30 过、n=29 不过（阈值 `minEffectiveSamples`）。
 */
function buildInteractiveFixture(root: string, n: number, ts = NOW): void {
  const S = "20261111-health";
  const events: TraceEventInput[] = [
    { event: "SessionStart", sessionId: S, timestamp: ts, data: { model: "x" } },
  ];
  const auditRows: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    events.push(
      pd(S, ts, {
        tool_name: "bash",
        outcome: "deny",
        prompted: true,
        confirm_via: "tui",
        execution_context: "main",
        step: "8-mode",
        mode: "default",
        tool_use_id: `tu-${i}`,
        reason_type: "other",
      }),
    );
    auditRows.push({
      timestamp: ts,
      type: "tool_use",
      tool: "bash",
      resource: `rm -rf /tmp/x${i}`,
      decision: "deny",
      reason: "非交互模式下自动拒绝: [high] 危险命令需要确认",
      session_id: S,
      tool_use_id: `tu-${i}`,
      decisionReason: { type: "other" },
      confirm_source: "user",
      user_confirmed: true,
    });
  }
  writeTrace(root, S, events);
  writeAudit(root, auditRows);
}

describe("runSelfCheck / buildReport：自检是硬门", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "permission-trace-gate-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const reportFor = (n: number, nowMs = Date.parse(NOW)) => {
    buildInteractiveFixture(root, n);
    return buildReport({
      sessionsDir: join(root, "trajectories", "sessions"),
      logsDir: join(root, "logs"),
      nowMs,
    });
  };

  test("阈值条数的交互式样本 → 四项全过，三张分布表齐全", () => {
    const n = THRESHOLDS.minEffectiveSamples;
    const report = reportFor(n);
    expect(report.selfCheck.passed).toBe(true);
    expect(report.selfCheck.effectiveSamples).toBe(n);
    expect(report.distribution).not.toBeNull();
    expect(report.distribution!.byModeOutcomeStep.length).toBeGreaterThan(0);
    expect(report.distribution!.byTool.length).toBeGreaterThan(0);
    expect(report.distribution!.byReasonType.length).toBeGreaterThan(0);
    expect(report.denialBreakdown).not.toBeNull();
    expect(report.denialBreakdown!.total).toBe(30);
  });

  test("★ 29 条（阈值差 1）→ 有效样本量不过，且 distribution 结构上为 null", () => {
    // 用 `distribution === null` 而不是渲染层字符串判断：让「有没有分布」成为
    // 数据结构的事实，而不是靠人肉约定「记得别打印」。
    const report = reportFor(29);
    expect(report.selfCheck.passed).toBe(false);
    expect(report.distribution).toBeNull();
    expect(report.denialBreakdown).toBeNull();
    const failed = report.selfCheck.items.filter((i) => !i.passed).map((i) => i.key);
    expect(failed).toEqual(["effectiveSamples"]);
  });

  test("★ skip 档占多数时不会把有效样本量撑上去（deny 不算有效样本）", () => {
    // 本机形态：9,239 条 skip allow + 0 条交互式。若脚本把 outcome=deny 或
    // skip 档算进分母，这个夹具会假通过。
    const S = "20261111-skipheavy";
    const events: TraceEventInput[] = [
      { event: "SessionStart", sessionId: S, timestamp: NOW, data: { model: "x" } },
    ];
    const auditRows: Record<string, unknown>[] = [];
    for (let i = 0; i < 200; i++) {
      events.push(
        pd(S, NOW, {
          tool_name: "bash",
          outcome: "allow",
          prompted: false,
          execution_context: "main",
          step: "skip",
          mode: "dangerously-skip-permissions",
          tool_use_id: `sk-${i}`,
        }),
      );
      auditRows.push({
        timestamp: NOW,
        type: "tool_use",
        tool: "bash",
        decision: "allow",
        reason: "skipPermissions",
        session_id: S,
        tool_use_id: `sk-${i}`,
      });
    }
    writeTrace(root, S, events);
    writeAudit(root, auditRows);

    const report = buildReport({
      sessionsDir: join(root, "trajectories", "sessions"),
      logsDir: join(root, "logs"),
      nowMs: Date.parse(NOW),
    });
    expect(report.buckets.skipped).toBe(200);
    expect(report.buckets.judged).toBe(0);
    expect(report.selfCheck.effectiveSamples).toBe(0);
    expect(report.selfCheck.passed).toBe(false);
  });

  test("★ 键覆盖率按最近数据日判：埋点上线前的历史数据不拖累护栏", () => {
    // 历史日 100 条全无键，今天 30 条全有键。整窗口口径会是 23% → 恒红；
    // 最近数据日口径是 100% → 护栏工作、且不误报「链路断了」。
    const S = "20261111-mixed";
    const events: TraceEventInput[] = [
      { event: "SessionStart", sessionId: S, timestamp: "2026-11-05T10:00:00.000Z", data: {} },
    ];
    const auditRows: Record<string, unknown>[] = [];
    for (let i = 0; i < 100; i++) {
      events.push(
        pd(S, "2026-11-05T10:00:00.000Z", {
          tool_name: "read",
          outcome: "allow",
          prompted: false,
          execution_context: "main",
          step: "10",
          mode: "default",
        }),
      );
      auditRows.push({
        timestamp: "2026-11-05T10:00:00.000Z",
        type: "tool_use",
        tool: "read",
        decision: "allow",
      });
    }
    for (let i = 0; i < 30; i++) {
      events.push(
        pd(S, "2026-11-11T10:00:00.000Z", {
          tool_name: "bash",
          outcome: "deny",
          prompted: true,
          confirm_via: "tui",
          execution_context: "main",
          step: "8-mode",
          mode: "default",
          tool_use_id: `new-${i}`,
        }),
      );
      auditRows.push({
        timestamp: "2026-11-11T10:00:00.000Z",
        type: "tool_use",
        tool: "bash",
        decision: "deny",
        session_id: S,
        tool_use_id: `new-${i}`,
        decisionReason: { type: "other" },
      });
    }
    writeTrace(root, S, events);
    writeAudit(root, auditRows);

    const report = buildReport({
      sessionsDir: join(root, "trajectories", "sessions"),
      logsDir: join(root, "logs"),
      nowMs: Date.parse(NOW),
    });
    const auditCov = report.selfCheck.items.find((i) => i.key === "auditKeyCoverage")!;
    expect(auditCov.value).toBe(1);
    expect(auditCov.passed).toBe(true);
    // detail 里点名了窗口整体值，读的人能看出「低的那部分是历史」
    expect(auditCov.detail).toContain("窗口整体");
  });
});

describe("buildDistribution：skip 档单列，永不并入主分母", () => {
  test("skip 档计入 skipped 列，不进 allow / deny", () => {
    const root = mkdtempSync(join(tmpdir(), "permission-trace-dist-"));
    try {
      const S = "s1";
      writeTrace(root, S, [
        { event: "SessionStart", sessionId: S, timestamp: NOW, data: {} },
        pd(S, NOW, {
          tool_name: "bash",
          outcome: "allow",
          prompted: false,
          execution_context: "main",
          step: "skip",
          mode: "dangerously-skip-permissions",
        }),
        pd(S, NOW, {
          tool_name: "bash",
          outcome: "deny",
          prompted: true,
          execution_context: "main",
          step: "8-mode",
          mode: "default",
        }),
        pd(S, NOW, {
          tool_name: "bash",
          outcome: "allow",
          prompted: false,
          execution_context: "main",
          step: "10",
          mode: "default",
        }),
      ]);
      const trace = readTraceIndex(join(root, "trajectories", "sessions"));
      const dist = buildDistribution(trace);
      const bash = dist.byTool.find((r) => r.tool === "bash")!;
      expect(bash.skipped).toBe(1);
      expect(bash.allow).toBe(1);
      expect(bash.deny).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("renderReport：自检不过时一张分布表都不打印", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "permission-trace-render-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const render = (n: number): string => {
    buildInteractiveFixture(root, n);
    const report = buildReport({
      sessionsDir: join(root, "trajectories", "sessions"),
      logsDir: join(root, "logs"),
      nowMs: Date.parse(NOW),
    });
    return renderReport(report, { noColor: true });
  };

  test("★ 自检不过：只有覆盖度层，没有任何分布表", () => {
    // 「只打警告而继续出表」等于静默降级：读的人看到的仍是一份正常报告。
    const text = render(5);
    expect(text).toContain("拒绝输出分布表");
    expect(text).not.toContain("分布（skip 档单列");
    expect(text).not.toContain("按工具");
    expect(text).not.toContain("按 reason_type");
    expect(text).not.toContain("拒绝成因");
  });

  test("自检全过：三张分布表 + 拒绝成因层都在", () => {
    const text = render(30);
    expect(text).not.toContain("拒绝输出分布表");
    expect(text).toContain("分布（skip 档单列");
    expect(text).toContain("按 mode × outcome × step");
    expect(text).toContain("按工具");
    expect(text).toContain("按 reason_type");
    expect(text).toContain("拒绝成因");
  });
});

// ─────────────────────────── flag 对账 ───────────────────────────

/**
 * `KNOWN_FLAGS` 与脚本里真实消费的 flag 双向对账（照 `trace-digest-flags.test.ts` 的模式）。
 *
 * 治的是同一类静默 bug：脚本接了新 flag 却忘了登记 → 被当成未知参数拒掉；
 * 或登记了却没实现 → 用户按帮助写了参数，脚本静默降级成默认视图。
 * 两种都不会有任何报错，只有一份「看起来正常」的输出。
 */
describe("flag 对账：声明与消费必须一致", () => {
  /** 从脚本源码里抽出真正被消费的 flag：`flags.has("--x")` 与 `args.indexOf("--x")` 两种形态 */
  function extractConsumedFlags(source: string): Set<string> {
    const declStart = source.indexOf("KNOWN_FLAGS = new Set([");
    let body = source;
    if (declStart >= 0) {
      const declEnd = source.indexOf("]);", declStart);
      body = source.slice(0, declStart) + source.slice(declEnd >= 0 ? declEnd + 3 : declStart);
    }
    const found = new Set<string>();
    for (const re of [
      /flags\.has\(\s*"(--[a-z-]+)"\s*\)/g,
      /args\.indexOf\(\s*"(--[a-z-]+)"\s*\)/g,
    ]) {
      for (const m of body.matchAll(re)) found.add(m[1]!);
    }
    return found;
  }

  test("提取器自身有效（防正则失效导致空对空的假绿）", () => {
    const consumed = extractConsumedFlags(readFileSync(SCRIPT_PATH, "utf-8"));
    expect(consumed.size).toBeGreaterThanOrEqual(3);
    expect(consumed.has("--days")).toBe(true);
  });

  test("① 消费的每个 flag 都在 KNOWN_FLAGS 里", () => {
    const consumed = extractConsumedFlags(readFileSync(SCRIPT_PATH, "utf-8"));
    expect([...consumed].filter((f) => !KNOWN_FLAGS.has(f))).toEqual([]);
  });

  test("② KNOWN_FLAGS 里的每个 flag 都被真的消费（防登记了没实现）", () => {
    const consumed = extractConsumedFlags(readFileSync(SCRIPT_PATH, "utf-8"));
    expect([...KNOWN_FLAGS].filter((f) => !consumed.has(f))).toEqual([]);
  });
});

// ─────────────────────────── CLI 端到端 ───────────────────────────

describe("CLI：退出码 0 全过 / 1 自检不过 / 2 用法错误", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "permission-trace-cli-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** SID_CONFIG_DIR 显式传给子进程：不继承进程内 env 改动（同仓踩过的坑） */
  function runScript(args: string[]): { code: number; stdout: string; stderr: string } {
    const proc = spawnSync("bun", [SCRIPT_PATH, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...process.env, SID_CONFIG_DIR: home, NO_COLOR: "1" },
    });
    return { code: proc.status ?? -1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
  }

  test("自检全过 → 退出码 0（CI / northstar 靠退出码判，不解析文本）", () => {
    // 用「当前时刻」当夹具时间戳，窗口过滤（默认 7 天）才稳；
    // 写死日期的话，这个测试会在真实日期跑过那一天之后悄悄变红。
    buildInteractiveFixture(home, 30, new Date().toISOString());
    const r = runScript([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("分布（skip 档单列");
  });

  test("自检不过 → 退出码 1，且 stdout 里没有分布表", () => {
    buildInteractiveFixture(home, 3, new Date().toISOString());
    const r = runScript([]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("拒绝输出分布表");
    expect(r.stdout).not.toContain("分布（skip 档单列");
  });

  test("未识别 flag → 退出码 2 + stderr 列出可用参数（不静默忽略）", () => {
    const r = runScript(["--nonexistent"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("未识别参数");
    expect(r.stderr).toContain("--days");
    expect(r.stdout).toBe("");
  });

  test("--days 非法值 / --session 缺值 → 退出码 2", () => {
    expect(runScript(["--days", "abc"]).code).toBe(2);
    expect(runScript(["--session"]).code).toBe(2);
  });

  test("--json 输出机器可读结构，且自检不过时 distribution 是 null", () => {
    buildInteractiveFixture(home, 3, new Date().toISOString());
    const r = runScript(["--json"]);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.selfCheck.passed).toBe(false);
    expect(parsed.distribution).toBeNull();
    expect(typeof parsed.buckets.judged).toBe("number");
  });
});
