#!/usr/bin/env bun
/**
 * telemetry-trigger-rate —— 遥测事件「定义数 vs 实测触发数」分诊脚本
 *
 * ── 为什么需要它 ──
 *
 * `RetryTelemetryEvent` 定义了 14 类事件，但真实会话里只有少数几类出现过。
 * 只报「14 类事件」会把**从未被验证过一次**的异常路径埋点记成已交付资产 ——
 * 这正是本仓反复记的那条教训：**有代码 ≠ 有能力**，新增防线的验收判据是
 * 「真实会话里被触发过」，不是「build 过 + 单测过」。
 *
 * 形态照 `defense-trigger-rate.ts`（同一套「防线触发率」思路，那边测工具调用，
 * 这边测遥测事件），事实源同为会话轨迹 events.jsonl。
 *
 * ── 三条刻意的口径决定 ──
 *
 * 1. **报两个数 + 报取数日期 + 报会话分母**，不只报「N 类触发」。
 *    分母不写，下次没法判断「M 类零触发」是真没接线还是样本太小 —— 这个数字是**活的**
 *    （历史上六天内就从「67 会话 / 2 类」变成「80 会话 / 3 类」），把它写死进任何文档
 *    都会在几天内变成一次漂移。所以结论应当**跑这个脚本得到**，而不是抄文档。
 *
 * 2. **零触发不等于死代码，脚本刻意不下这个判断。** 异常路径埋点不触发可能意味着
 *    「最近没出故障」（好事）。脚本只做机械分类：有无发射点（静态）× 有无触发（运行时），
 *    四个格子里只有「有发射点 + 零触发 + 且路径可达性可疑」需要人去看。
 *    自动判「死代码」会诱导删掉真正的防线。
 *
 * 3. **分母用「有 events.jsonl 的会话数」，不是盘上目录数。** 无 events.jsonl 的目录
 *    对本指标没有观测能力，算进分母会稀释信号（盘上目录数恒 ≥ 有效会话数）。
 *    两个数都打印出来，避免下次有人拿不同分母复算得出不同结论。
 *
 * 用法：
 *   bun scripts/telemetry-trigger-rate.ts                # 扫最近 200 个会话
 *   bun scripts/telemetry-trigger-rate.ts --all          # 扫全部
 *   bun scripts/telemetry-trigger-rate.ts --limit 50
 *   bun scripts/telemetry-trigger-rate.ts --json         # 机器可读
 *
 * 每类事件的源码发射点见 EVENT_CATALOG 的 `emitter` 字段（也会打印在零触发清单里）。
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths, listSessions } from "@sid-code/core/trace/digest.ts";

/**
 * 14 类事件的登记表 + 每类的「归属」。
 *
 * ⚠️ 这份清单**不是**从源码正则扫出来的，是显式登记的。理由：曾经有人用
 * `rg -o '\| "[a-z0-9_]+"' retry-telemetry.ts | sort -u | wc -l` 数出「15 类」，
 * 多出来的那个是 `phase?: "connection" | "stream"` 里的 `"stream"` —— 正则不认识
 * 「这是另一个字段的取值」。按那个数去分诊会凭空多出一类永不触发的幽灵事件。
 * 反漂移由 `packages/core/tests/llm/retry-telemetry.test.ts` 的穷尽 Record 负责。
 */
const EVENT_CATALOG: Record<string, { emitter: string; kind: "normal" | "exception" }> = {
  // 正常路径：每次流都会走，是「仪器本身活着」的心跳
  stream_completed: { emitter: "stream-lifecycle.ts", kind: "normal" },

  // 异常路径：只在真故障时触发，零触发需要分诊
  retry: { emitter: "fallback.ts", kind: "exception" },
  fallback: { emitter: "fallback.ts", kind: "exception" },
  "529_dropped": { emitter: "fallback.ts", kind: "exception" },
  max_tokens_adjust: { emitter: "fallback.ts", kind: "exception" },
  persistent_retry_wait: { emitter: "fallback.ts", kind: "exception" },
  auth_refresh: { emitter: "fallback.ts", kind: "exception" },
  non_streaming_degrade: { emitter: "fallback.ts", kind: "exception" },
  retry_budget_exhausted: { emitter: "fallback.ts", kind: "exception" },
  shared_cooldown_wait: { emitter: "fallback.ts", kind: "exception" },
  stream_stall: { emitter: "stream-lifecycle.ts", kind: "exception" },
  stream_idle_timeout: { emitter: "stream-lifecycle.ts", kind: "exception" },
  stream_content_progress_timeout: { emitter: "stream-lifecycle.ts", kind: "exception" },
  stream_overall_timeout: { emitter: "stream-lifecycle.ts", kind: "exception" },
};

/** TimeoutFired 的 layer 枚举（用于交叉核验：哪一层的超时真的在生产里赢过 race）。 */
/**
 * ⚠️ 这是手写副本，必须与 `trace/stream-observer.ts` 的 `TimeoutLayer` 联集一致。
 * 有哨兵测试（`tests/trace/timeout-layer-catalog-sync.test.ts`）机械核对两处 ——
 * 手写清单在本仓有多次漂移前科，漏一层的后果是"那一层永远显示零触发"，
 * 而零触发看起来完全正常（就像它从没出过故障），是最难发现的那类缺陷。
 */
const TIMEOUT_LAYERS = [
  "header_timeout",
  "idle_timeout",
  "content_progress_timeout",
  "fallback_stream_timeout",
  "turn_hard_timeout",
  "agent_heartbeat_timeout",
  "agent_overall_timeout",
  // PR11（§4.5）：此前这两层开枪不留痕（watchdog 只发 WatchdogKill、
  // fetchAbsolute 把 abort 委托给 runtime），于是本脚本结构性地看不到它们。
  "watchdog_kill",
  "fetch_absolute_timeout",
];

interface Scan {
  /** 有 events.jsonl 的会话数（本指标的真分母） */
  sessionsWithEvents: number;
  /** 每类遥测事件的累计触发次数 */
  eventCounts: Record<string, number>;
  /** 每类遥测事件「在几个会话里出现过」（比总次数更抗单会话刷量） */
  eventSessions: Record<string, number>;
  /** TimeoutFired 各 layer 的累计次数（交叉核验用） */
  timeoutLayers: Record<string, number>;
  /** retry 事件的 reopenReason 分布 —— 回答「重试是被哪一层判超时引发的」 */
  reopenReasons: Record<string, number>;
  /** 最早 / 最晚会话 id（取数窗口，报给读者判断样本新鲜度） */
  firstSession: string | null;
  lastSession: string | null;
}

function scan(limit: number): { scan: Scan; dirsOnDisk: number } {
  const paths = resolvePaths();
  const refs = listSessions(paths);
  const dirsOnDisk = existsSync(paths.sessionsDir)
    ? readdirSync(paths.sessionsDir).filter((d) => !d.startsWith(".")).length
    : 0;

  const picked = refs.slice(0, limit === Infinity ? refs.length : limit);

  const s: Scan = {
    sessionsWithEvents: 0,
    eventCounts: {},
    eventSessions: {},
    timeoutLayers: {},
    reopenReasons: {},
    firstSession: null,
    lastSession: null,
  };

  const ids: string[] = [];

  for (const ref of picked) {
    const p = join(ref.dir, "events.jsonl");
    if (!existsSync(p)) continue;
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    s.sessionsWithEvents++;
    ids.push(ref.id);

    /** 本会话内出现过的事件类型（用于 eventSessions 去重计数） */
    const seenHere = new Set<string>();

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const data = ev.data ?? {};

      if (ev.event === "RetryTelemetry") {
        const t = data.type;
        if (typeof t !== "string") continue;
        s.eventCounts[t] = (s.eventCounts[t] ?? 0) + 1;
        seenHere.add(t);
        if (t === "retry") {
          const r = typeof data.reopenReason === "string" ? data.reopenReason : "(none)";
          s.reopenReasons[r] = (s.reopenReasons[r] ?? 0) + 1;
        }
      } else if (ev.event === "TimeoutFired") {
        const layer = data.layer;
        if (typeof layer === "string") {
          s.timeoutLayers[layer] = (s.timeoutLayers[layer] ?? 0) + 1;
        }
      }
    }

    for (const t of seenHere) {
      s.eventSessions[t] = (s.eventSessions[t] ?? 0) + 1;
    }
  }

  ids.sort();
  s.firstSession = ids[0] ?? null;
  s.lastSession = ids[ids.length - 1] ?? null;

  return { scan: s, dirsOnDisk };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const all = args.includes("--all");
  const limIdx = args.indexOf("--limit");
  const limit = all ? Infinity : limIdx >= 0 ? Number(args[limIdx + 1]) || 200 : 200;

  const { scan: s, dirsOnDisk } = scan(limit);

  if (s.sessionsWithEvents === 0) {
    process.stderr.write("未找到任何含 events.jsonl 的会话，无法评估。\n");
    process.exit(1);
  }

  const defined = Object.keys(EVENT_CATALOG);
  const triggered = defined.filter((t) => (s.eventCounts[t] ?? 0) > 0);
  const zero = defined.filter((t) => (s.eventCounts[t] ?? 0) === 0);
  const zeroException = zero.filter((t) => EVENT_CATALOG[t]!.kind === "exception");

  // 取数日期：用会话 id 前缀（形如 20260816-...），比 Date.now() 更能说明**样本**窗口。
  const window = `${s.firstSession?.slice(0, 8) ?? "?"} → ${s.lastSession?.slice(0, 8) ?? "?"}`;

  const summary = {
    // 口径三件套：两个数 + 取数窗口 + 分母（缺一就会变成下一次漂移）
    definedTypes: defined.length,
    triggeredTypes: triggered.length,
    zeroTriggerTypes: zero.length,
    sampleWindow: window,
    denominator: {
      sessionsWithEvents: s.sessionsWithEvents,
      dirsOnDisk,
      note: "分母用 sessionsWithEvents；dirsOnDisk 仅供对照（含无观测能力的空目录）",
    },
    triggered: Object.fromEntries(
      triggered.map((t) => [t, { calls: s.eventCounts[t]!, sessions: s.eventSessions[t] ?? 0 }]),
    ),
    zeroTrigger: zero,
    timeoutLayers: s.timeoutLayers,
    retryReopenReasons: s.reopenReasons,
  };

  if (json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return;
  }

  const L: string[] = [];
  L.push("═══ 遥测事件触发率（定义 vs 实测） ═══");
  L.push(
    `口径：${summary.definedTypes} 类定义 / ${summary.triggeredTypes} 类实测触发` +
      `　样本窗口 ${window}　分母 ${s.sessionsWithEvents} 个含 events.jsonl 的会话` +
      `（盘上目录 ${dirsOnDisk}）`,
  );
  L.push("");
  L.push("已触发：");
  for (const t of triggered.sort((a, b) => (s.eventCounts[b] ?? 0) - (s.eventCounts[a] ?? 0))) {
    const kind = EVENT_CATALOG[t]!.kind === "normal" ? "正常" : "异常";
    L.push(
      `  ${t.padEnd(32)} ${String(s.eventCounts[t]).padStart(5)} 次` +
        `  ${String(s.eventSessions[t] ?? 0).padStart(3)}/${s.sessionsWithEvents} 会话  [${kind}]`,
    );
  }
  L.push("");
  L.push(`零触发（${zero.length} 类，其中异常路径 ${zeroException.length} 类）：`);
  for (const t of zero) {
    L.push(`  ${t.padEnd(32)} ← ${EVENT_CATALOG[t]!.emitter}`);
  }

  // 交叉核验：TimeoutFired 的 layer 分布能证伪「三层超时都在工作」这类说法。
  // 若这里只有 fallback_stream_timeout，而 lifecycle 三层全 0，那不是"最近没超时"
  // （明明超时了），是**阈值配比让 lifecycle 三层永远抢不到**。
  L.push("");
  L.push("交叉核验 · TimeoutFired 各层实测次数（哪一层真的赢过 race）：");
  const anyLayer = TIMEOUT_LAYERS.some((l) => (s.timeoutLayers[l] ?? 0) > 0);
  if (!anyLayer) {
    L.push("  （无 TimeoutFired 记录 —— 样本里没有超时发生）");
  } else {
    for (const l of TIMEOUT_LAYERS) {
      const n = s.timeoutLayers[l] ?? 0;
      L.push(`  ${l.padEnd(28)} ${String(n).padStart(4)} 次${n === 0 ? "   ← 零触发" : ""}`);
    }
  }

  if (Object.keys(s.reopenReasons).length > 0) {
    L.push("");
    L.push("retry 的 reopenReason 分布（重试是被什么引发的）：");
    for (const [r, n] of Object.entries(s.reopenReasons).sort((a, b) => b[1] - a[1])) {
      L.push(`  ${r.padEnd(28)} ${String(n).padStart(4)} 次`);
    }
  }

  L.push("");
  L.push("判读（脚本刻意不替你判「死代码」）：");
  L.push("  异常路径零触发有两种成因，二者修法相反，必须人工分辨：");
  L.push("    ① 最近无故障 —— 好事，什么都不用做；");
  L.push("    ② 结构性不可达 —— 发射点在，但条件永远不成立（阈值配比/闸门顺序/前置未接线）。");
  L.push("  分辨方法：拿上面的交叉核验对照。若某类故障**确实发生过**（如 TimeoutFired 有记录）");
  L.push("  而对应遥测仍 0，那就是 ②，不是 ①。");

  process.stdout.write(L.join("\n") + "\n");
}

main();
