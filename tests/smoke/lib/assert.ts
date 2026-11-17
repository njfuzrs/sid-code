/**
 * 轨迹断言：对 events.jsonl 的事件计数匹配、对用例仓文件的内容匹配。
 *
 * 失败信息要能直接定位：写出期望、实际条数、以及同名事件里最接近的几条 data，
 * 让人不打开轨迹也能判断是「事件没发」还是「字段变了」。
 */
import type { EventExpect, FileExpect } from "./types.ts";

export interface TraceEvent {
  event: string;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

export function parseEvents(jsonl: string): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj.event === "string") out.push(obj);
    } catch {
      // 进程被杀时的半行：跳过。漏掉的事件会让对应断言失败，不会被吞成通过。
    }
  }
  return out;
}

/** 取 `raw.jsonl` 里带 `request` 的行（响应行没有它），按顺序返回 `request` 字段。半行同样跳过。 */
export function parseRawRequests(jsonl: string): unknown[] {
  const out: unknown[] = [];
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && obj.request !== undefined) out.push(obj.request);
    } catch {
      // 同 parseEvents：漏掉的请求会让依赖它的断言失败，不会被吞成通过
    }
  }
  return out;
}

/**
 * 从事件里取一个字段：先按整键查（`data` 优先，再顶层），再按 `a.b` 点号路径查。
 *
 * 点号路径是 2026-11-17 补的：`TurnComplete.goal_limit_exceeded` / `GoalGateDecision.wait_ids`
 * 这类**嵌套 payload** 用整键只能拿到对象引用，而 `where` 的值是按 `===` 比的，
 * 于是断言恒不命中——写的人会以为字段没落，实际是断言表达不了。
 * 先查整键是刻意的：`data` 里可能有字面量含点的键，既有用例不能因此改变行为。
 */
function fieldOf(e: TraceEvent, key: string): unknown {
  if (e.data && key in e.data) return e.data[key];
  if (key in e) return e[key];
  const dot = key.indexOf(".");
  if (dot <= 0) return undefined;
  const head = key.slice(0, dot);
  let cur: unknown = e.data && head in e.data ? e.data[head] : e[head];
  for (const seg of key.slice(dot + 1).split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function matchesWhere(e: TraceEvent, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, v]) => fieldOf(e, k) === v);
}

/** 返回 null 表示通过，否则返回失败描述。 */
export function checkEventExpect(events: TraceEvent[], exp: EventExpect): string | null {
  const sameName = events.filter((e) => e.event === exp.event);
  const hits = sameName.filter((e) => matchesWhere(e, exp.where));
  const count = exp.count ?? ">=1";
  const ok =
    typeof count === "number" ? hits.length === count : hits.length >= Number(count.slice(2));
  if (ok) return null;
  const sample = sameName
    .slice(0, 3)
    .map((e) => JSON.stringify(e.data ?? {}).slice(0, 200))
    .join("\n      ");
  return (
    `事件 ${exp.event} ${JSON.stringify(exp.where ?? {})} 期望 ${count} 条，实际 ${hits.length} 条` +
    `（同名事件共 ${sameName.length} 条${sameName.length ? `，前几条 data:\n      ${sample}` : ""}）`
  );
}

/** `read` 由调用方注入，返回 null 表示文件不存在。 */
export function checkFileExpect(
  read: (p: string) => string | null,
  exp: FileExpect,
): string | null {
  const content = read(exp.path);
  if ("absent" in exp) {
    return content === null ? null : `文件 ${exp.path} 期望不存在，实际存在`;
  }
  if (content === null) return `文件 ${exp.path} 不存在`;
  if ("equals" in exp && content !== exp.equals) {
    return `文件 ${exp.path} 内容不等：期望 ${JSON.stringify(exp.equals)}，实际 ${JSON.stringify(content)}`;
  }
  if ("contains" in exp && !content.includes(exp.contains)) {
    return `文件 ${exp.path} 不含 ${JSON.stringify(exp.contains)}，实际 ${JSON.stringify(content.slice(0, 200))}`;
  }
  return null;
}
