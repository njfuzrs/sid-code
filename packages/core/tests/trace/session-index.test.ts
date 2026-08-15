/**
 * session-index（P0-2）测试：让轨迹类指标不随 LRU 清理消失。
 *
 * 本文件的核心不是"读写对不对"，而是**那条 LRU 端到端**：造 105 个会话触发
 * LRU 后，目录只剩 100 个而索引仍有 105 行。这是 P0-2 存在的全部理由 ——
 * 修复前 TTFT p50 从 4.7s "变成" 3.3s 不是性能改善，是 LRU 换了一批样本。
 *
 * 经 SID_CODE_SESSION_INDEX 重定向到 tmp，不触碰真实 ~/.sid-code。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  upsertSessionIndex,
  readSessionIndex,
  pruneSessionIndex,
  sessionIndexPath,
  buildSessionIndexEntry,
  type SessionIndexEntry,
} from "@sid-code/core/trace/session-index.ts";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { getSidHome } from "@sid-code/core/config/paths.ts";

let dir: string;
// 存/恢复原值，不无条件 delete —— bun test 同进程跑多文件，delete 会抹掉别人的隔离
const savedIndex = process.env.SID_CODE_SESSION_INDEX;

function row(over: Partial<SessionIndexEntry> & { session_id: string }): SessionIndexEntry {
  return {
    ts: 1_700_000_000,
    app_version: "0.1.601",
    model: "claude-sonnet-5",
    exit_status: "end_turn",
    duration_ms: 1000,
    turns: 3,
    total_steps: 5,
    cost_usd: 0.01,
    tokens_sent: 1000,
    tokens_received: 200,
    // n 恒落（缺省 0）：区分"没接埋点"与"接了但无样本"，见 SessionIndexEntry.ttft_n
    ttft_n: 0,
    e2e_n: 0,
    real_errors: 0,
    anomalies_count: 0,
    pathological: [],
    compactions: 0,
    defense_triggered: false,
    traj_corrupt: false,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-session-index-"));
  process.env.SID_CODE_SESSION_INDEX = join(dir, "session-index.jsonl");
});

afterEach(() => {
  if (savedIndex === undefined) delete process.env.SID_CODE_SESSION_INDEX;
  else process.env.SID_CODE_SESSION_INDEX = savedIndex;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("session-index 读写与隔离契约", () => {
  test("upsert 后能读回", () => {
    upsertSessionIndex(row({ session_id: "s1" }));
    const all = readSessionIndex();
    expect(all).toHaveLength(1);
    expect(all[0]!.session_id).toBe("s1");
  });

  test("同一会话多次 upsert 只保留一行，取最后一次值", () => {
    // 长驻会话每轮 flush 若用 append，消费侧按行计数会让"会话数"翻 N 倍
    upsertSessionIndex(row({ session_id: "s1", turns: 1, cost_usd: 0.01 }));
    upsertSessionIndex(row({ session_id: "s1", turns: 30, cost_usd: 0.5 }));
    const all = readSessionIndex();
    expect(all).toHaveLength(1);
    expect(all[0]!.turns).toBe(30);
    expect(all[0]!.cost_usd).toBeCloseTo(0.5, 6);
  });

  test("不同会话各占一行", () => {
    upsertSessionIndex(row({ session_id: "a" }));
    upsertSessionIndex(row({ session_id: "b" }));
    expect(readSessionIndex()).toHaveLength(2);
  });

  test("文件不存在返回空数组，不抛错", () => {
    expect(readSessionIndex()).toEqual([]);
  });

  test("损坏行被跳过，其余行照常读出（采集失败绝不连带毁掉整份索引）", () => {
    upsertSessionIndex(row({ session_id: "ok1" }));
    const p = sessionIndexPath();
    const { appendFileSync } = require("node:fs");
    appendFileSync(p, "这不是 json\n");
    appendFileSync(p, JSON.stringify({ 没有主键: true }) + "\n");
    upsertSessionIndex(row({ session_id: "ok2" }));
    const all = readSessionIndex();
    expect(all.map((e) => e.session_id).sort()).toEqual(["ok1", "ok2"]);
  });

  test("未设环境变量时落在配置根目录下且与 trajectories/ 同级（不在其下）", () => {
    // 这条是 P0-2 的**结构性前提**：放进 trajectories/ 就会被将来任何对该目录的
    // 清理连带删掉，而索引存在的唯一理由就是"删了还在"
    delete process.env.SID_CODE_SESSION_INDEX;
    const p = sessionIndexPath();
    expect(p.startsWith(getSidHome())).toBe(true);
    expect(p.endsWith("session-index.jsonl")).toBe(true);
    expect(p.includes("trajectories")).toBe(false);
  });

  test("空串 / 纯空白视为未设置，回落默认路径（避免误重定向到空路径）", () => {
    process.env.SID_CODE_SESSION_INDEX = "   ";
    expect(sessionIndexPath().startsWith(getSidHome())).toBe(true);
  });

  test("prune 保留最近 N 行，且不会自动被调用", () => {
    for (let i = 0; i < 10; i++) upsertSessionIndex(row({ session_id: `s${i}` }));
    expect(readSessionIndex()).toHaveLength(10);
    expect(pruneSessionIndex(3)).toBe(3);
    expect(readSessionIndex().map((e) => e.session_id)).toEqual(["s7", "s8", "s9"]);
  });
});

describe("buildSessionIndexEntry 字段映射", () => {
  test("分位数无样本时字段缺失，不落 0（0 会被读成 0 毫秒）", () => {
    const e = buildSessionIndexEntry(
      { session_id: "s1", model: "m" },
      { ts: 1, ttft: { n: 0 }, e2e: { n: 0 } },
    );
    expect(e.ttft_p50).toBeUndefined();
    expect("ttft_p50" in e).toBe(false);
    expect(e.ttft_n).toBe(0);
    // n=0 必须落：它区分了"没样本"与"该版本还没接这个埋点"
    expect("ttft_n" in e).toBe(true);
  });

  test("有分位数时原样落盘，含 n", () => {
    const e = buildSessionIndexEntry(
      { session_id: "s1" },
      { ts: 1, ttft: { p50: 3300, p95: 14500, n: 12 } },
    );
    expect(e.ttft_p50).toBe(3300);
    expect(e.ttft_p95).toBe(14500);
    expect(e.ttft_n).toBe(12);
  });

  test("e2e 字段缺失表示该版本无 TurnComplete 埋点（PR-4 前的形态）", () => {
    // 字段先占位的理由：让索引字段集从第一天稳定，PR-4 落地后不必迁移历史行
    const e = buildSessionIndexEntry({ session_id: "s1" }, { ts: 1 });
    expect("e2e_p50" in e).toBe(false);
    expect(e.e2e_n).toBe(0);
  });

  test("app_version 缺失时不写该键（与账本存量行同一形态）", () => {
    const e = buildSessionIndexEntry({ session_id: "s1" }, { ts: 1 });
    expect("app_version" in e).toBe(false);
  });

  test("traj_corrupt / defense_triggered 缺省为 false，不是 undefined", () => {
    // 这两个是 bool 指标，undefined 会让消费侧的 `filter(x => x.traj_corrupt)`
    // 与 `filter(x => x.traj_corrupt === false)` 加起来不等于总数
    const e = buildSessionIndexEntry({ session_id: "s1" }, { ts: 1 });
    expect(e.traj_corrupt).toBe(false);
    expect(e.defense_triggered).toBe(false);
  });

  test("summary 字段类型异常时回落 0，不产出 NaN/undefined 污染聚合", () => {
    const e = buildSessionIndexEntry(
      { session_id: "s1", cost_usd: "0.5" as unknown as number, turns: null },
      { ts: 1 },
    );
    expect(e.cost_usd).toBe(0);
    expect(e.turns).toBe(0);
  });
});

/**
 * P0-2 的核心验收（不可省）：LRU 删掉会话目录后，指标必须还在。
 *
 * 这条测的是修复前那个具体故障：`pruneOldSessions()` 用 rmSync 删整个会话目录，
 * session-summary.json 一起没了，于是所有轨迹类指标每几十个会话换一批样本。
 */
describe("P0-2 端到端：LRU 触发后目录被删而索引仍在", () => {
  test("105 个会话 + LRU 上限 100 → 目录剩 100，索引仍 105 行", () => {
    const trajDir = join(dir, "trajectories");
    const sessionsDir = join(trajDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    // 造 105 个会话目录，同时每个都在索引里留一行（模拟 SessionEnd 已落过索引）
    for (let i = 0; i < 105; i++) {
      const id = `sess-${String(i).padStart(3, "0")}`;
      const d = join(sessionsDir, id);
      mkdirSync(d, { recursive: true });
      // 放一个文件，避免被 pruneStaleBlankSessions 当空壳处理（它另有判据）
      writeFileSync(join(d, "session.traj"), JSON.stringify({ metadata: {} }), "utf-8");
      upsertSessionIndex(row({ session_id: id, ttft_p50: 3000 + i }));
    }
    expect(readdirSync(sessionsDir)).toHaveLength(105);
    expect(readSessionIndex()).toHaveLength(105);

    // 构造 collector 即触发 LRU（构造函数里调 pruneOldSessions）
    new TraceCollector({ outputDir: trajDir, maxSessionsRetained: 100 });

    // 目录被删到上限
    expect(readdirSync(sessionsDir)).toHaveLength(100);
    // 而索引一行都没少 —— 这就是 P0-2 要的效果
    const idx = readSessionIndex();
    expect(idx).toHaveLength(105);

    // 且被删目录的那些会话，指标仍可复算（拿最旧的几个抽查）
    const survivingDirs = new Set(readdirSync(sessionsDir));
    const deletedIds = idx.map((e) => e.session_id).filter((id) => !survivingDirs.has(id));
    expect(deletedIds.length).toBe(5);
    for (const id of deletedIds) {
      const e = idx.find((x) => x.session_id === id)!;
      // 目录没了，但 TTFT 与版本号还在 —— 曲线不会因为清理而断点
      expect(e.ttft_p50).toBeGreaterThan(0);
      expect(e.app_version).toBe("0.1.601");
    }
  });

  test("指标可复现：同一份索引连算两次，结果字节级相同", () => {
    // §八 第 2 项验收的最小化版本。不可复现的指标证明不了任何改进
    for (let i = 0; i < 20; i++) {
      upsertSessionIndex(row({ session_id: `s${i}`, ttft_p50: 3000 + i * 10 }));
    }
    const a = JSON.stringify(readSessionIndex());
    const b = JSON.stringify(readSessionIndex());
    expect(a).toBe(b);
  });
});

/**
 * P2-14：采集损坏率可见。
 *
 * 实测 1/56 = 1.8% 的 session.traj 损坏率 —— collector 有损坏检测与降级保存，
 * 但没有任何指标统计它。涨到 20% 也不会有人知道。
 */
describe("P2-14 轨迹损坏率可见", () => {
  test("坏 json 的 session.traj 让该会话 traj_corrupt === true", async () => {
    const { buildDigest, resolvePaths } = await import("@sid-code/core/trace/digest.ts");
    const trajDir = join(dir, "trajectories");
    const sessionsDir = join(trajDir, "sessions");
    const id = "sess-corrupt";
    const d = join(sessionsDir, id);
    mkdirSync(d, { recursive: true });
    // 故意写不可解析的 json（collector 的降级保存路径产出的正是这种文件）
    const trajPath = join(d, "session.traj");
    writeFileSync(trajPath, '{"metadata": {这不是合法 json', "utf-8");
    writeFileSync(join(d, "events.jsonl"), "", "utf-8");

    const digest = buildDigest(
      { id, dir: d, trajPath, mtimeMs: 0 },
      false,
      resolvePaths(join(dir, "root-not-used")),
    );
    expect(digest).not.toBeNull();
    expect(digest!.sessionMetrics!.trajCorrupt).toBe(true);

    // 落进索引后同样可见
    const e = buildSessionIndexEntry(
      { session_id: id },
      { ts: 1, traj_corrupt: digest!.sessionMetrics!.trajCorrupt },
    );
    upsertSessionIndex(e);
    expect(readSessionIndex()[0]!.traj_corrupt).toBe(true);
  });

  test("正常 traj 的会话 traj_corrupt === false（不误报）", async () => {
    const { buildDigest, resolvePaths } = await import("@sid-code/core/trace/digest.ts");
    const id = "sess-ok";
    const d = join(dir, "trajectories", "sessions", id);
    mkdirSync(d, { recursive: true });
    const trajPath = join(d, "session.traj");
    writeFileSync(
      trajPath,
      JSON.stringify({ metadata: { session_id: id, model: "m" }, trajectory: [] }),
      "utf-8",
    );
    writeFileSync(join(d, "events.jsonl"), "", "utf-8");

    const digest = buildDigest(
      { id, dir: d, trajPath, mtimeMs: 0 },
      false,
      resolvePaths(join(dir, "root-not-used")),
    );
    expect(digest!.sessionMetrics!.trajCorrupt).toBe(false);
  });

  test("损坏率可从索引直接算出（分母是索引行数，口径写死）", () => {
    upsertSessionIndex(row({ session_id: "a", traj_corrupt: true }));
    for (let i = 0; i < 55; i++) upsertSessionIndex(row({ session_id: `ok${i}` }));
    const all = readSessionIndex();
    const corrupt = all.filter((e) => e.traj_corrupt).length;
    expect(corrupt).toBe(1);
    expect(all).toHaveLength(56);
    // 1/56 ≈ 1.8%，与实测一致
    expect((corrupt / all.length) * 100).toBeCloseTo(1.8, 1);
  });
});

describe("aggregateSessionMetrics 口径", () => {
  test("TTFT 与 aggregateProviderStats 同源：跨 provider 合并为会话级分位数", async () => {
    const { aggregateSessionMetrics, aggregateProviderStats } =
      await import("@sid-code/core/trace/digest.ts");
    // 两个 provider 各两个样本 —— 会话级必须是四个样本一起排，
    // 不是两个 provider 的 p50 再平均（p50 的平均不是平均的 p50）
    const events = [
      { event: "StreamPhase", data: { phase: "first_content", model: "claude-x", ttft_ms: 1000 } },
      { event: "StreamPhase", data: { phase: "first_content", model: "claude-x", ttft_ms: 2000 } },
      {
        event: "StreamPhase",
        data: { phase: "first_content", model: "deepseek-y", ttft_ms: 3000 },
      },
      {
        event: "StreamPhase",
        data: { phase: "first_content", model: "deepseek-y", ttft_ms: 4000 },
      },
    ];
    const m = aggregateSessionMetrics(events, { trajCorrupt: false });
    expect(m.ttft_n).toBe(4);
    expect(m.ttft_p50).toBe(2000);
    // provider 侧仍是分桶的两行 —— 证明两者不是同一个口径，索引取的是会话级那个
    expect(aggregateProviderStats(events).length).toBe(2);
  });

  test("无 TTFT 样本时 n=0 且分位数 undefined", async () => {
    const { aggregateSessionMetrics } = await import("@sid-code/core/trace/digest.ts");
    const m = aggregateSessionMetrics([], { trajCorrupt: false });
    expect(m.ttft_n).toBe(0);
    expect(m.ttft_p50).toBeUndefined();
  });

  test("ttft_ms <= 0 的脏样本被剔除（与 provider 侧同款判据）", async () => {
    const { aggregateSessionMetrics } = await import("@sid-code/core/trace/digest.ts");
    const m = aggregateSessionMetrics(
      [
        { event: "StreamPhase", data: { phase: "first_content", ttft_ms: 0 } },
        { event: "StreamPhase", data: { phase: "first_content", ttft_ms: -5 } },
        { event: "StreamPhase", data: { phase: "first_content", ttft_ms: 1200 } },
      ],
      { trajCorrupt: false },
    );
    expect(m.ttft_n).toBe(1);
    expect(m.ttft_p50).toBe(1200);
  });

  test("防线触发：hypothesis_register / challenge / verify 子代理任一即为 true", async () => {
    const { aggregateSessionMetrics } = await import("@sid-code/core/trace/digest.ts");
    const mk = (data: Record<string, unknown>) =>
      aggregateSessionMetrics([{ event: "PreToolUse", data }], { trajCorrupt: false })
        .defenseTriggered;
    expect(mk({ tool_name: "hypothesis_register" })).toBe(true);
    expect(mk({ tool_name: "hypothesis_challenge" })).toBe(true);
    expect(mk({ tool_name: "sub_agent", tool_input: { agent_type: "verify" } })).toBe(true);
    // 普通子代理不算触发防线 —— 否则触发率会被日常并行搜索灌成接近 100%
    expect(mk({ tool_name: "sub_agent", tool_input: { agent_type: "general" } })).toBe(false);
    expect(mk({ tool_name: "read_file" })).toBe(false);
  });

  test("端到端耗时读 TurnComplete；该事件不存在时 n=0（PR-4 前）", async () => {
    const { aggregateSessionMetrics } = await import("@sid-code/core/trace/digest.ts");
    const before = aggregateSessionMetrics([{ event: "StreamPhase", data: {} }], {
      trajCorrupt: false,
    });
    expect(before.e2e_n).toBe(0);

    const after = aggregateSessionMetrics(
      [
        { event: "TurnComplete", data: { elapsed_ms_since_prompt: 8000 } },
        { event: "TurnComplete", data: { elapsed_ms_since_prompt: 12000 } },
      ],
      { trajCorrupt: false },
    );
    expect(after.e2e_n).toBe(2);
    expect(after.e2e_p50).toBe(8000);
  });
});

/**
 * 增量路径（plan §2.3 item 3）—— 这不是优化，是必需项。
 *
 * 实测本机 `SessionStart 55 : SessionEnd 25`：30 个会话没有终态。只挂 SessionEnd
 * 等于放弃 54.5% 的样本，而 P0-2 的全部目的就是"样本不要丢"。同一个坑账本踩过
 * （只在退出路径落一行 → 交互式会话长期计 $0）。
 */
describe("P0-2 增量路径：没有 SessionEnd 的会话也进索引", () => {
  /** 起一个会话并跑 N 轮，**不** fire SessionEnd（模拟 Ctrl-C / kill / 关终端） */
  async function runWithoutSessionEnd(sessionId: string, rounds: number) {
    const { HookSystem } = await import("@sid-code/core/hook/system.ts");
    const hooks = new HookSystem();
    hooks.setSessionId(sessionId);
    hooks.setCwd("/tmp/test");
    const collector = new TraceCollector({ outputDir: join(dir, "trajectories") });
    collector.registerHooks(hooks);
    await hooks.fireSessionStartEvent("startup", {
      model: "claude-test",
      app_version: "9.9.9-incr",
    });
    for (let i = 0; i < rounds; i++) {
      await hooks.fireBeforeModelEvent({
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
        raw_messages: [{ role: "user", content: "hi" }],
      });
      await hooks.fireAfterModelEvent(
        {
          model: "claude-test",
          messages: [],
          raw_messages: [{ role: "user", content: "hi" }],
        },
        {
          content_blocks: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        } as never,
      );
    }
  }

  test("首轮后索引即有一行（崩溃前就跑掉的短会话不会一行都没有）", async () => {
    await runWithoutSessionEnd("sess-no-end", 1);
    const mine = readSessionIndex().find((e) => e.session_id === "sess-no-end");
    expect(mine).toBeDefined();
    expect(mine!.app_version).toBe("9.9.9-incr");
    expect(mine!.turns).toBeGreaterThanOrEqual(1);
  });

  test("增量行标 exit_status=incomplete —— 不能被误当成正常结束", async () => {
    // 留空会被消费侧当成未知态；标 end_turn 则会把"没善终"混进"正常结束"里
    await runWithoutSessionEnd("sess-incomplete", 1);
    const mine = readSessionIndex().find((e) => e.session_id === "sess-incomplete")!;
    expect(mine.exit_status).toBe("incomplete");
  });

  test("增量行的质量结论为空，消费侧必须靠 exit_status 区分（不是零错误）", async () => {
    // 增量路径刻意不跑 digest（每轮跑会把它变成长会话热路径），
    // 所以 real_errors=0 表示"还没算"而非"没有错误"
    await runWithoutSessionEnd("sess-quality", 1);
    const mine = readSessionIndex().find((e) => e.session_id === "sess-quality")!;
    expect(mine.real_errors).toBe(0);
    expect(mine.pathological).toEqual([]);
    expect(mine.exit_status).toBe("incomplete");
  });

  test("多轮只留一行（upsert 语义，不随轮数翻倍）", async () => {
    await runWithoutSessionEnd("sess-multi", 4);
    expect(readSessionIndex().filter((e) => e.session_id === "sess-multi")).toHaveLength(1);
  });

  test("SessionEnd 到达时权威行覆盖增量行（exit_status 不再是 incomplete）", async () => {
    const { HookSystem } = await import("@sid-code/core/hook/system.ts");
    const hooks = new HookSystem();
    hooks.setSessionId("sess-upgrade");
    hooks.setCwd("/tmp/test");
    const collector = new TraceCollector({ outputDir: join(dir, "trajectories") });
    collector.registerHooks(hooks);
    await hooks.fireSessionStartEvent("startup", { model: "claude-test" });
    await hooks.fireBeforeModelEvent({
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      raw_messages: [{ role: "user", content: "hi" }],
    });
    await hooks.fireAfterModelEvent(
      {
        model: "claude-test",
        messages: [],
        raw_messages: [{ role: "user", content: "hi" }],
      },
      {
        content_blocks: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      } as never,
    );
    // 增量行已在
    expect(readSessionIndex().find((e) => e.session_id === "sess-upgrade")!.exit_status).toBe(
      "incomplete",
    );

    await hooks.fireSessionEndEvent("exit");

    const rows = readSessionIndex().filter((e) => e.session_id === "sess-upgrade");
    expect(rows).toHaveLength(1); // 仍是一行
    expect(rows[0]!.exit_status).not.toBe("incomplete"); // 已升级为终态
  });
});

describe("collector 接线：SessionEnd 落索引", () => {
  test("真实会话走完 SessionEnd 后索引里有该会话一行且带版本号", async () => {
    const { HookSystem } = await import("@sid-code/core/hook/system.ts");
    const trajDir = join(dir, "trajectories");
    const hooks = new HookSystem();
    hooks.setSessionId("sess-wire");
    hooks.setCwd("/tmp/test");
    const collector = new TraceCollector({ outputDir: trajDir });
    collector.registerHooks(hooks);

    await hooks.fireSessionStartEvent("startup", {
      model: "claude-test",
      app_version: "9.9.9-wire",
    });
    await hooks.fireBeforeModelEvent({
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      raw_messages: [{ role: "user", content: "hi" }],
    });
    await hooks.fireAfterModelEvent(
      {
        model: "claude-test",
        messages: [],
        raw_messages: [{ role: "user", content: "hi" }],
      },
      {
        content_blocks: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      } as never,
    );
    await hooks.fireSessionEndEvent("exit");

    const all = readSessionIndex();
    const mine = all.find((e) => e.session_id === "sess-wire");
    expect(mine).toBeDefined();
    expect(mine!.app_version).toBe("9.9.9-wire");
    expect(mine!.turns).toBeGreaterThanOrEqual(1);
    expect(mine!.traj_corrupt).toBe(false);
    // summary 与 index 必须同源：拿盘上的 session-summary.json 逐字段比
    const summaryPath = join(trajDir, "sessions", "sess-wire", "session-summary.json");
    expect(existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(require("node:fs").readFileSync(summaryPath, "utf-8"));
    expect(mine!.cost_usd).toBe(summary.cost_usd);
    expect(mine!.turns).toBe(summary.turns);
    expect(mine!.real_errors).toBe(summary.real_errors);
  });
});
