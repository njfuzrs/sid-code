/**
 * 方案 §7.2「真实轨迹回放用例（**必做**）」——2026-11-16 goal 空转会话的末 140 条 bash。
 *
 * ## 夹具从哪来
 *
 * 会话 `20261116-010710-b38e91d0`（`/goal 盯着 16 个 PR 直到全部合并`）在 01:13–02:00 之间
 * 前台查了 **130 次**外部状态，其中 15 分钟窗口内 119 次模型调用。那是 PR #899 / #897
 * 修完之后仍然存在的形态：3 个 monitor 在盯同一个 PR 队列，模型仍每隔 6–7 秒查一次。
 *
 * 夹具 `fixtures/goal-idle-poll-20261116.json` 是那次会话 `session.traj` 里
 * `tool_name === "bash"` 的**末 140 条**命令与对应工具结果，脱敏只做两件事：
 * 私有 checkout 路径 → `<repo>`，owner 名 → `<owner>`。PR 号、run id、时间戳、表格列数
 * 全部保留原样——这些正是签名与归一化要面对的形态，改掉就不再是「真实轨迹」。
 *
 * ## 三条断言对应方案的三个通过线
 *
 * 1. 识别率 ≥ 95%（现状 128/140 未识别 → 修复后 140/140）；
 * 2. 实际执行 ≤ 20 次（现状 130 → 实测 11）；
 * 3. 状态变化仍可见：至少 2 次在变化后 ≤ 1 个 monitor 周期（180s）内被看到。
 *    这一条防「拦得越多越好」——拦到看不见变化是 §3.8 已经踩过的坑。
 *
 * **第 3 条的限制（方案 §7.2 原文明写，这里如实保留）**：P1 的 120s 探测窗口保证
 * 「未被 monitor 覆盖时每 120s 至少放行一次」，所以第 15 次之前这条成立；
 * **P5 第二档之后不再有探测放行**（§4.10 的取舍：硬拦绕过探测窗口）。
 * 实测可见的 4 次全部落在前 11 次实际执行内，与此一致。
 *
 * ## 这个用例守的是哪一层
 *
 * G1（不跑模型、不起进程，纯函数 + 固定夹具）。它替代的是「真实会话里再空转 15 分钟」
 * 这种不可复现的验收方式——方案 §7.5 的端到端指标只能靠真实任务，
 * 而「识别率」和「执行次数」这两条在这里就可复算。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  checkStatusQueryPoll,
  createWaitPollEscalation,
  recordStatusQueryResult,
  WAIT_POLL_BLOCK_AFTER,
  WAIT_POLL_HINT_AFTER,
  type StatusPollContext,
} from "../../src/task/status-poll-guard.ts";
import { matchStatusQuery, normalizeStatusOutput } from "../../src/task/status-query-commands.ts";
import type { WaitSource } from "../../src/task/index.ts";

interface FixtureRow {
  at: string;
  command: string;
  output: string;
}

const ROWS: FixtureRow[] = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "goal-idle-poll-20261116.json"), "utf8"),
) as FixtureRow[];

/** 一次 monitor 周期的上限（脚本每 180s 轮询；方案 §7.2 第 3 条用同一个数） */
const MONITOR_PERIOD_MS = 180_000;

/**
 * 回放里唯一的等待源：会话里那个 `bash <script>` monitor。
 *
 * `subjects` / `commandFamilies` 不是手填的产物 —— 它们是 `readWaitScriptBodies` +
 * `collectWaitSubjects` / `collectWaitCommandFamilies` 对夹具脚本
 * `fixtures/watch-prs.sh`（会话里 `/tmp/watch-prs.sh` 的入库版本）的真实输出：
 * 脚本里只有 `gh pr list`，所以只覆盖 `gh_pr_list` 一族、一个 PR 集合对象。
 * 这一点决定了回放里 118 条 `gh run list` **不被覆盖**、只能走探测窗口 ——
 * 是现场事实，不是测试偷懒。
 */
function replayWait(t0: number): WaitSource {
  return {
    id: "m6w0l1vdp",
    kind: "monitor",
    promise: { kind: "deadline", deadlineAt: t0 + 30 * 60_000 },
    description: "sid-code PR 合并队列",
    registeredAt: t0,
    subjects: ["gh:prs:current:open"],
    commandFamilies: ["gh_pr_list"],
  };
}

interface ReplayResult {
  /** 未被拦截、真正执行的次数 */
  executed: number;
  intercepted: number;
  /** 被执行的那些查询的时刻（毫秒） */
  executedAt: number[];
  /** P5 提示送达的次数与每次的文案 */
  hints: { index: number; text: string; delivered: boolean }[];
  /** 拦截回执里带 P5 前缀的次数 */
  prefixedReceipts: number;
  finalCount: number;
}

/**
 * 按时间顺序把 140 条命令喂给 P1 守卫 + P5 计数。
 *
 * 拦截时不 `record`（真实路径里工具没执行，没有新输出可记），放行时才 `record` ——
 * 这与 `tool-executor.ts` 的「先 check、执行后 record」顺序一致。
 */
function replay(): ReplayResult {
  const t0 = Date.parse(ROWS[0]!.at);
  let now = t0;
  const ctx: StatusPollContext = {
    hasDeclaredExternalWait: () => true,
    listWaits: () => [replayWait(t0)],
    memo: { entries: new Map() },
    escalation: createWaitPollEscalation(),
    now: () => now,
  };

  const out: ReplayResult = {
    executed: 0,
    intercepted: 0,
    executedAt: [],
    hints: [],
    prefixedReceipts: 0,
    finalCount: 0,
  };

  ROWS.forEach((row, i) => {
    now = Date.parse(row.at);
    const checked = checkStatusQueryPoll("bash", { command: row.command }, ctx);
    if (checked.intercept) {
      out.intercepted++;
      // 方案 §4.10 第 4 条：P1 已给出回执时，P5 的提示「改成一句前缀」。
      if (String(checked.output ?? "").startsWith("[等待期第")) out.prefixedReceipts++;
      return;
    }
    out.executed++;
    out.executedAt.push(now);
    if (checked.hint) out.hints.push({ index: i + 1, text: checked.hint, delivered: true });
    recordStatusQueryResult(row.command, row.output, ctx);
  });

  out.finalCount = ctx.escalation?.count ?? 0;
  return out;
}

describe("真实轨迹回放：2026-11-16 goal 空转会话末 140 条 bash（§7.2）", () => {
  test("夹具是真实的 140 条，且全部能被识别为状态查询（≥95%）", () => {
    expect(ROWS.length).toBe(140);

    const identified = ROWS.filter((r) => matchStatusQuery(r.command) !== null);
    const ratio = identified.length / ROWS.length;
    // 方案通过线是 ≥95%，这里连实测值一起锁住：修复前 12/140（8.6%），修复后 140/140。
    expect(ratio).toBeGreaterThanOrEqual(0.95);
    expect(identified.length).toBe(140);

    // 四个人族的分布也锁住：如果哪天 `gh pr list` 或 `gh run list` 的识别退化，
    // 总数断言可能仍成立（别的命令顶上），但这里会立刻变红。
    const byFamily = new Map<string, number>();
    for (const r of ROWS) {
      const m = matchStatusQuery(r.command);
      if (!m) continue;
      byFamily.set(m.family, (byFamily.get(m.family) ?? 0) + 1);
    }
    expect([...byFamily.entries()].sort()).toEqual([
      ["gh_pr_checks", 7],
      ["gh_pr_list", 9],
      ["gh_run_list", 118],
      ["gh_run_view", 6],
    ]);
  });

  test("回放后实际执行 ≤20 次（修复前 130 次，实测 11）", () => {
    const r = replay();
    expect(r.executed + r.intercepted).toBe(140);
    // 方案 §7.2 第 2 条：≤20 = 15（P5 硬拦）+ 5（识别漏网 / 首轮探测余量）。
    // 实测 11，余量来自「前 11 次里有几次输出真的变了」而不是掐着阈值走。
    expect(r.executed).toBeLessThanOrEqual(20);
    expect(r.executed).toBe(11);
    expect(r.intercepted).toBe(129);
  });

  test("P5 计数覆盖全部 140 次（被 P1 拦下的也计入），第 15 次起硬拦", () => {
    const r = replay();
    expect(r.finalCount).toBe(140);
    expect(WAIT_POLL_HINT_AFTER).toBe(5);
    expect(WAIT_POLL_BLOCK_AFTER).toBe(15);
    // 硬拦生效后一次都不再执行：第 15 次之后的查询全部走 intercepted。
    // 用「最后一次执行的序号」间接验证：实测最后执行落在前 15 条内。
    const lastExecIdx = ROWS.reduce(
      (acc, row, i) => (r.executedAt.includes(Date.parse(row.at)) ? i + 1 : acc),
      0,
    );
    expect(lastExecIdx).toBeLessThanOrEqual(WAIT_POLL_BLOCK_AFTER);
  });

  test("P5 第 5 次的提示只送一次，且含「还剩几次硬拦」", () => {
    const r = replay();
    expect(r.hints.length).toBe(1);
    const hint = r.hints[0]!;
    expect(hint.index).toBe(WAIT_POLL_HINT_AFTER);
    expect(hint.text).toContain("第 5 次");
    expect(hint.text).toContain(String(WAIT_POLL_BLOCK_AFTER));
  });

  test("状态变化仍可见：至少 2 次在变化后 ≤180s 内被看到", () => {
    const r = replay();
    const executedAt = r.executedAt;

    // 变化点按**真实输出**算（不看这次是否被执行）——否则「被拦住了所以没变化」
    // 会把断言变成恒真。分组键用签名，同一签名的相邻两次归一化值不同才算一次变化。
    const bySig = new Map<string, { at: number; norm: string }[]>();
    for (const row of ROWS) {
      const m = matchStatusQuery(row.command);
      if (!m) continue;
      const norm = normalizeStatusOutput(m.kind, row.output);
      const list = bySig.get(m.signature) ?? [];
      list.push({ at: Date.parse(row.at), norm });
      bySig.set(m.signature, list);
    }

    const changes: number[] = [];
    for (const list of bySig.values()) {
      for (let i = 1; i < list.length; i++) {
        if (list[i]!.norm !== list[i - 1]!.norm) changes.push(list[i]!.at);
      }
    }
    changes.sort((a, b) => a - b);
    expect(changes.length).toBe(26);

    // 「看到」= 变化后 180s 内有一次实际执行（探测窗口 120s 保证它会发生，
    // 除非已被 P5 硬拦按死在 15 次之后）。
    const visible = changes.filter((at) =>
      executedAt.some((t) => t >= at && t - at <= MONITOR_PERIOD_MS),
    );
    expect(visible.length).toBe(4);
    // 方案的通过线是「3 次真实状态变化中至少 2 次」。实测 4 次，
    // 且全部落在前 11 次实际执行内 —— 与「硬拦之后不再有探测放行」的限制一致。
    expect(visible.length).toBeGreaterThanOrEqual(2);
  });
});
