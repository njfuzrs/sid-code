/**
 * S（修复方案 §7.3 第 3/4 条 + §7.5 第 1 条）：等待放行 → 收到通知续跑 → 评估器判达成。
 *
 * 期望来源：修复方案 §7.3（2026-11-16）——
 * 「等待期间模型调用 0 次」「收到通知后才有下一次模型调用」「最终目标达成」。
 * ⚠️ 实现落的是 `goal.status === "complete"`（`goal-gate.ts` 的 satisfied 分支），
 * 方案原文写的 `achieved` 是措辞笔误，本用例按实现字段断言（已在方案文档回写）。
 *
 * 与 `S-goal-wait` 的分工：那条守「等待期不调评估器（不空转）」，这条守「等待结束后
 * 目标真的收尾」——两条路径的后半段不同，合并会让失败归因变糊。
 *
 * ⚠️ 为什么是「造数据」：本机 1200+ 会话里没有一条「goal + 等待 + 续跑 + 达成」的
 * 真实轨迹，而且**修复前这条路径根本走不到**（等待期就被推回空转），等真实样本等于
 * 永远不验收。回放夹具按方案 §7.3 的期望构造，**不是从真实轨迹抄的**——这一性质必须
 * 在用例头注明，不能让它冒充真实采样。
 *
 * ⚠️ 为什么用 `-p` 单轮：等待放行后 monitor 终态触发通知续跑，续跑轮会多产生一条
 * `result`，与 `streamInput` 的「输入数 === result 数」断言冲突（S-goal-wait 头注释
 * 记录了实测 1 → 2）。`-p` 单轮只看事件与退出码。
 *
 * 时间序列断言（等待期 0 次模型调用）放在 `expect.output`：事件计数表达不了「某段时间
 * 区间内不许发生」，必须读轨迹按时间戳判。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOutput, SmokeCase } from "../../lib/types.ts";

type Ev = {
  event: string;
  timestamp?: string;
  data?: Record<string, unknown>;
};

/** 读本次会话轨迹；返回 null 表示文件缺失（由调用方报错）。 */
function readTrajectory(out: RunOutput): Ev[] | null {
  const sid = (out.stdout as { session_id?: string } | null)?.session_id;
  if (!sid) return null;
  const path = join(out.configDir, "trajectories/sessions", sid, "events.jsonl");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Ev];
      } catch {
        return [];
      }
    });
}

const def: SmokeCase = {
  id: "S-goal-wait-achieved",
  ledger: "S",
  feature: "goal 等待结束后续跑并由评估器判达成（等待期模型调用 0 次）",
  kind: "guard",
  repo: {},
  argv: ["-p", "/goal set 完成迁移工作"],
  timeoutMs: 150_000,
  settings: ({ defaults }) => ({
    ...defaults,
    // 不再靠撞 turns_limited 收尾：续跑轮 end_turn 后由评估器（回放第 4 条）判 satisfied。
    goal: { defaultMaxTurns: 10 },
  }),
  expect: {
    exitCode: 0,
    events: [
      // 判「在等」：恰好一条 waiting
      { event: "GoalGateDecision", where: { reason: "waiting" }, count: 1 },
      // 等待结束后评估器判达成：satisfied 恰好一条，且 goal 落到 complete
      { event: "GoalGateDecision", where: { reason: "satisfied" }, count: 1 },
      { event: "GoalGateDecision", where: { status: "complete" }, count: 1 },
      // 等待原语本身有始有终
      { event: "WaitRegistered", count: 1 },
      { event: "WaitReleased", count: 1 },
      // 不许用 turns_limited / budget 收尾：本用例要的是「达成」，不是「撞上限」
      { event: "GoalGateDecision", where: { reason: "turns_limited" }, count: 0 },
    ],
    output: (out) => {
      const events = readTrajectory(out);
      if (!events) return "找不到本次会话轨迹（session_id 缺失或 events.jsonl 不存在）";
      // 窗口起点必须是「挂起生效」那一刻，不是 WaitRegistered：
      // monitor 在 tool_use 阶段就注册（WaitRegistered 早于首轮 end_turn），
      // 而首轮还要再请求一次拿 end_turn——把它算成「等待期调用」会误判正常收尾。
      // §7.5 要测的是「等待挂起之后不再有新调用」。
      const suspended = events.find(
        (e) => e.event === "GoalGateDecision" && e.data?.reason === "waiting",
      );
      const rel = events.find((e) => e.event === "WaitReleased");
      if (!suspended?.timestamp || !rel?.timestamp) {
        return "缺 GoalGateDecision(waiting) / WaitReleased 时间戳";
      }
      const start = Date.parse(suspended.timestamp);
      const end = Date.parse(rel.timestamp);
      if (!(start < end))
        return `等待窗口异常：挂起 ${suspended.timestamp} 不早于释放 ${rel.timestamp}`;
      const beforeModels = events.filter((e) => {
        if (e.event !== "BeforeModel" || !e.timestamp) return false;
        const ts = Date.parse(e.timestamp);
        return ts > start && ts < end;
      });
      if (beforeModels.length !== 0) {
        return `等待挂起期间发生了 ${beforeModels.length} 次模型调用（方案 §7.5 要求 0 次）`;
      }
      const afterRelease = events.filter((e) => {
        if (e.event !== "BeforeModel" || !e.timestamp) return false;
        return Date.parse(e.timestamp) > end;
      });
      if (afterRelease.length === 0) {
        return "等待释放后没有续跑模型调用（方案 §7.3 要求收到通知后才有下一次调用）";
      }
      return null;
    },
  },
  mutations: [
    {
      file: "packages/core/src/query/goal-gate.ts",
      find: "  if (waitSuspend.release) {",
      replace: "  if (false && waitSuspend.release) {",
      why: "等待判据失效：挂上 monitor 后 end_turn 仍去调评估器，续跑轮走不到、目标无法收尾（G2 要修的原缺陷）",
    },
  ],
};

export default def;
