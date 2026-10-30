/**
 * T4：防线注册表登记门禁（`query/defense-registry.ts`）。
 *
 * 键完备性大半交给 tsc（`Record<ContinueReason["type"], …>` 漏一项编译不过），
 * 这里专门验证两件 tsc 管不到的事：
 *
 * 1. **事件名锚点完备**：`packages/core/src/query/` 源码里发射的 trace 事件名，
 *    集合必须与 `EVENT_ANCHORS` 的键相等。新加一个 `event: "Xxx"` 发射点不登记就红。
 * 2. **内容不能撒谎**：`metricSource` 能解析到真实发射点、`toggle.env` 真被读取、
 *    `cap` 与 `CONTINUE_STREAK_CAPS` 双向一致、`triage` 约束成立。只查「非空」的话，
 *    写个 `"todo"` 也能过。
 *
 * 这是源码字面量断言，`affected-tests` 按目录映射选不到它 —— 改事件名、env 名前先
 * `grep -rnF '<旧字面量>' packages/core/tests`。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import {
  DEFENSES,
  CONTINUE_ANCHORS,
  INCOMPLETE_ANCHORS,
  EVENT_ANCHORS,
  CONTINUE_TYPES,
  GATE_CONTINUE_TYPES,
  type DefenseDef,
  type DefenseAnchor,
} from "@sid-code/core/query/defense-registry.ts";
import { CONTINUE_STREAK_CAPS } from "@sid-code/core/query/transition.ts";
import { LOOP_STATE_FLAG_KIND } from "@sid-code/core/query/types.ts";

const SRC = join(import.meta.dir, "../../src");
const QUERY = join(SRC, "query");

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSources(p));
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const querySources = listSources(QUERY).map((p) => ({ path: p, text: readFileSync(p, "utf8") }));
const allSrcText = listSources(SRC)
  .map((p) => readFileSync(p, "utf8"))
  .join("\n");

/**
 * 解析 `query/` 内**发射**的 trace 事件名：`traceAppendEvent(` / `emitTraceEvent(` 之后、
 * 下一个 `traceAppendEvent` 之前出现的首个 `event: "Xxx"`。
 *
 * 不用全文 `event: "Xxx"`：`types.ts` 的 `StreamEventMessage.event: "stream_start" | …`
 * 是消息类型字段，不是 trace 事件，全文扫会把它当成未登记的防线。
 */
function emittedEventNames(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const { path, text } of querySources) {
    const re = /traceAppendEvent(?:\?\.)?\(\s*\{\s*event:\s*"([A-Za-z_]+)"/g;
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split("\n").length;
      const where = `${relative(SRC, path)}:${line}`;
      found.set(m[1]!, [...(found.get(m[1]!) ?? []), where]);
    }
  }
  return found;
}

const defs = DEFENSES as Record<string, DefenseDef>;
const allAnchors: Array<[string, string, DefenseAnchor]> = [
  ...Object.entries(CONTINUE_ANCHORS).map(
    ([k, v]) => ["continue", k, v] as [string, string, DefenseAnchor],
  ),
  ...Object.entries(INCOMPLETE_ANCHORS).map(
    ([k, v]) => ["incomplete", k, v] as [string, string, DefenseAnchor],
  ),
  ...Object.entries(EVENT_ANCHORS).map(
    ([k, v]) => ["event", k, v] as [string, string, DefenseAnchor],
  ),
];

describe("防线注册表：锚点完备", () => {
  test("query/ 发射的 trace 事件名 == EVENT_ANCHORS 的键（多一个、少一个都红）", () => {
    const emitted = emittedEventNames();
    // 解析器自检：解析结果太少说明正则写窄了，此时下面的集合比较会静默变弱
    expect(emitted.size).toBeGreaterThanOrEqual(20);
    const unregistered = [...emitted.keys()]
      .filter((e) => !(e in EVENT_ANCHORS))
      .map((e) => `${e}（${emitted.get(e)!.join(", ")}）`);
    const stale = Object.keys(EVENT_ANCHORS).filter((e) => !emitted.has(e));
    expect({ unregistered, stale }).toEqual({ unregistered: [], stale: [] });
  });

  test("goal-gate 的 emitTraceEvent 包装也被解析到（GoalGateDecision）", () => {
    // 包装函数内部仍是 traceAppendEvent({ event: … })，确认解析器没把它漏掉
    expect(emittedEventNames().has("GoalGateDecision")).toBe(true);
  });

  test("每个锚点条目要么指向存在的防线，要么带非空 notDefenseReason", () => {
    const bad: string[] = [];
    for (const [kind, key, a] of allAnchors) {
      if ("defenseId" in a) {
        if (!(a.defenseId in defs)) bad.push(`${kind}:${key} → 不存在的防线 ${a.defenseId}`);
      } else if (!a.notDefenseReason.trim()) {
        bad.push(`${kind}:${key} 的 notDefenseReason 为空`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("每道防线至少被一个锚点引用，或 metricSource 显式声明 none（没有孤儿定义）", () => {
    const referenced = new Set(
      allAnchors.flatMap(([, , a]) => ("defenseId" in a ? [a.defenseId as string] : [])),
    );
    const orphans = Object.entries(defs)
      .filter(([id, d]) => !referenced.has(id) && !("none" in d.metricSource))
      .map(([id]) => id);
    expect(orphans).toEqual([]);
  });
});

describe("防线注册表：内容不能撒谎", () => {
  const emitted = emittedEventNames();

  test("metricSource 可解析：event 有发射点，transition 是 ContinueReason 成员且锚点指回本防线", () => {
    const bad: string[] = [];
    for (const [id, d] of Object.entries(defs)) {
      const m = d.metricSource;
      if ("event" in m) {
        if (!emitted.has(m.event)) bad.push(`${id}: 事件 ${m.event} 在 query/ 里没有发射点`);
        const a = EVENT_ANCHORS[m.event];
        if (a && !("defenseId" in a && a.defenseId === id))
          bad.push(`${id}: 事件 ${m.event} 的锚点没指回本防线`);
      } else if ("transition" in m) {
        const a = (CONTINUE_ANCHORS as Record<string, DefenseAnchor>)[m.transition];
        if (!a) bad.push(`${id}: ${m.transition} 不是 ContinueReason 成员`);
        else if (!("defenseId" in a && a.defenseId === id))
          bad.push(`${id}: transition ${m.transition} 的锚点没指回本防线`);
      } else if (!m.none.trim()) {
        bad.push(`${id}: metricSource.none 必须写明为什么没有取数口径`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("toggle.env 在 packages/core/src 里真被读取", () => {
    const bad: string[] = [];
    for (const [id, d] of Object.entries(defs)) {
      if ("none" in d.toggle) {
        if (!d.toggle.none.trim()) bad.push(`${id}: toggle.none 为空`);
        continue;
      }
      for (const env of d.toggle.env ?? []) {
        // 三种读法：process.env.X / env.X（注入 env 参数）/ 常量 "X" 再 process.env[常量]
        const read =
          new RegExp(`\\benv\\.${env}\\b`).test(allSrcText) ||
          new RegExp(`=\\s*"${env}"`).test(allSrcText);
        if (!read) bad.push(`${id}: ${env} 在源码里没有读取点`);
      }
      if (d.toggle.setting) {
        const schema = readFileSync(join(SRC, "config/settings/types.ts"), "utf8");
        if (!new RegExp(`\\b${d.toggle.setting}:\\s*z\\.`).test(schema))
          bad.push(`${id}: setting ${d.toggle.setting} 不在 settings schema 里`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("cap 一致：streak ⇔ CONTINUE_STREAK_CAPS，flag 必须是 set_only，constant 真被导出", async () => {
    const bad: string[] = [];
    const streakTypes = new Set<string>();
    for (const [t, a] of Object.entries(CONTINUE_ANCHORS)) {
      if (!("defenseId" in a)) continue;
      const d = defs[a.defenseId]!;
      if (d.cap.kind === "streak") {
        streakTypes.add(t);
        if (CONTINUE_STREAK_CAPS[t as keyof typeof CONTINUE_STREAK_CAPS] === undefined)
          bad.push(`${t}: 防线 ${a.defenseId} 标 streak，但 CONTINUE_STREAK_CAPS 没有这个键`);
      }
    }
    for (const t of Object.keys(CONTINUE_STREAK_CAPS)) {
      if (!streakTypes.has(t)) bad.push(`CONTINUE_STREAK_CAPS.${t}: 注册表里对应防线不是 streak`);
    }
    for (const [id, d] of Object.entries(defs)) {
      const cap = d.cap;
      if (cap.kind === "flag" && LOOP_STATE_FLAG_KIND[cap.field] !== "set_only")
        bad.push(`${id}: cap.flag ${cap.field} 不是 set_only`);
      if (cap.kind === "constant") {
        const mod = await import(join(QUERY, cap.module));
        if (typeof mod[cap.name] !== "number")
          bad.push(`${id}: ${cap.module} 未导出 number ${cap.name}`);
      }
      if (cap.kind === "none" && !cap.reason.trim()) bad.push(`${id}: cap.none 必须写理由`);
      if (cap.kind === "config" && !cap.key.trim()) bad.push(`${id}: cap.config 的 key 为空`);
      // streak 防线必须真的有 continue 锚点，否则「从 CONTINUE_STREAK_CAPS 取」无处可取
      if (
        cap.kind === "streak" &&
        ![...streakTypes].some((t) => {
          const a = (CONTINUE_ANCHORS as Record<string, DefenseAnchor>)[t]!;
          return "defenseId" in a && a.defenseId === id;
        })
      )
        bad.push(`${id}: 标 streak 但没有 continue 锚点`);
    }
    expect(bad).toEqual([]);
  });

  test("triage 约束：B 类 precondition 非空；非 D 类 retireWhen 不得写「零触发」", () => {
    const bad: string[] = [];
    for (const [id, d] of Object.entries(defs)) {
      if (d.triage === "B" && !d.precondition?.trim()) bad.push(`${id}: B 类缺 precondition`);
      if (d.triage !== "D" && /零触发/.test(d.retireWhen))
        bad.push(
          `${id}: ${d.triage} 类的 retireWhen 不许写「零触发」（会把「没人用」算成「可以拆」）`,
        );
      if (!d.retireWhen.trim()) bad.push(`${id}: retireWhen 为空`);
      if (!d.assumption.trim()) bad.push(`${id}: assumption 为空`);
      if (!d.incident.trim()) bad.push(`${id}: incident 为空（摘不出来写 unknown）`);
    }
    expect(bad).toEqual([]);
  });

  test("gate 与 endTurnChain 自洽：用户授权防线在链上、不占 ExhaustibleGate", () => {
    const bad: string[] = [];
    for (const [id, d] of Object.entries(defs)) {
      if (d.authorizedByUser && (!d.endTurnChain || d.gate !== null))
        bad.push(`${id}: 用户授权防线应在 end_turn 链上且 gate=null`);
    }
    expect(bad).toEqual([]);
  });
});

describe("防线注册表：清单收口", () => {
  test("GATE_CONTINUE_TYPES 派生结果与收口前手写的 8 个逐字相同", () => {
    expect([...GATE_CONTINUE_TYPES].sort()).toEqual(
      [
        "stop_hook_retry",
        "unanswered_retry",
        "promise_nudge",
        "todo_gate_retry",
        "hypothesis_gate_retry",
        "token_budget_continuation",
        "goal_gate_retry",
        "goal_budget_warning",
      ].sort(),
    );
  });

  test("digest 与报告脚本不再手写清单，改从注册表取", () => {
    const digest = readFileSync(join(SRC, "trace/digest.ts"), "utf8");
    expect(digest).toContain('from "../query/defense-registry.ts"');
    expect(digest).not.toMatch(/const GATE_CONTINUE_TYPES\s*=/);
    const report = readFileSync(
      join(import.meta.dir, "../../../../scripts/defense-trigger-report.ts"),
      "utf8",
    );
    expect(report).toContain("@sid-code/core/query/defense-registry.ts");
    expect(report).not.toMatch(/CONTINUE_TYPES\s*=\s*\[/);
    expect(CONTINUE_TYPES.length).toBe(17);
  });
});
