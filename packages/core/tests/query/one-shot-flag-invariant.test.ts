/**
 * T3a：`LoopState` 布尔字段写入方式门禁。
 *
 * 分类常量 `LOOP_STATE_FLAG_KIND`（`query/types.ts`）规定每个布尔字段允许怎样被写：
 * - set_only：全仓只许 `= true`
 * - entry_reset：回落（`= false` / `= undefined` / `delete`）只许在 `beginTurn` 函数体内
 * - pending_consume：回落恰好一处（消费点）
 * - tracking：不约束
 *
 * 为什么扫 `packages/core/src/` 全部源码而不只是 `query/`：state 会被传进别的域的 helper，
 * 只扫 `query/` 时在 helper 里清零照样绿。
 *
 * 这是源码字面量断言，`affected-tests` 按目录映射选不到它 —— 改字段名前先
 * `grep -rnF '<字段名>' packages/core/tests`。
 *
 * 拦不住的一类：`resumeWithNotifications` 续跑时 state 整体重建，不写任何赋值（见方案 T3b）。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { LOOP_STATE_FLAG_KIND } from "@sid-code/core/query/types.ts";

const SRC = join(import.meta.dir, "../../src");
const TYPES_FILE = join(SRC, "query/types.ts");
const TURN_COMPLETE_FILE = join(SRC, "query/turn-complete.ts");

interface Write {
  file: string;
  line: number;
  field: string;
  rhs: string; // 字面右值；delete 记为 "delete"
}

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSources(p));
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** 注释行不算写入（loop.ts 里有「不得在 continue 分支重置为 false」这类说明）。 */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

const FIELDS = Object.keys(LOOP_STATE_FLAG_KIND);
const FIELD_ALT = FIELDS.join("|");
// 只匹配成员写入（`x.field = ...` / `x["field"] = ...`）。agentic-loop.ts 里有同名的局部变量，
// 那不是 LoopState，不能算进来。复合赋值（??= ||= &&=）一并收进来：`&&=` 同样能把标志拉回 false。
const ASSIGN_RE = new RegExp(
  String.raw`(?:\.(${FIELD_ALT})\b|\[\s*["'](${FIELD_ALT})["']\s*\])\s*(\?\?=|\|\|=|&&=|=(?!=))\s*([^;,\n)]*)`,
  "g",
);
const DELETE_RE = new RegExp(String.raw`\bdelete\s+[\w$.\]\["']*?\.(${FIELD_ALT})\b`, "g");

function scanWrites(): { writes: Write[]; fileCount: number } {
  const files = listSources(SRC);
  const writes: Write[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (isCommentLine(text)) return;
      for (const m of text.matchAll(ASSIGN_RE)) {
        const op = m[3]!;
        const rhs = op === "=" ? m[4]!.trim() : `${op} ${m[4]!.trim()}`;
        writes.push({ file, line: i + 1, field: (m[1] ?? m[2])!, rhs });
      }
      for (const m of text.matchAll(DELETE_RE)) {
        writes.push({ file, line: i + 1, field: m[1]!, rhs: "delete" });
      }
    });
  }
  return { writes, fileCount: files.length };
}

const isTrue = (w: Write) => w.rhs === "true";
const isFalsy = (w: Write) => w.rhs === "false" || w.rhs === "undefined" || w.rhs === "delete";
const fmt = (w: Write) => `${relative(SRC, w.file)}:${w.line} ${w.field} ${w.rhs}`;

/** `beginTurn` 函数体的行号区间（含首尾），用花括号配对，不依赖它在文件里的位置。 */
function beginTurnRange(): [number, number] {
  const lines = readFileSync(TURN_COMPLETE_FILE, "utf8").split("\n");
  const start = lines.findIndex((l) => /export function beginTurn\s*\(/.test(l));
  if (start < 0) throw new Error("turn-complete.ts 里找不到 beginTurn");
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") depth--;
    }
    if (opened && depth === 0) return [start + 1, i + 1];
  }
  throw new Error("beginTurn 花括号不配对");
}

/** 从 types.ts 源码解析 `LoopState` 顶层布尔字段（`?: boolean` 与 `: boolean` 都要收）。 */
function parseLoopStateBooleanFields(): string[] {
  const src = readFileSync(TYPES_FILE, "utf8");
  const start = src.indexOf("export interface LoopState {");
  if (start < 0) throw new Error("types.ts 里找不到 LoopState");
  const fields: string[] = [];
  let depth = 0;
  for (const raw of src.slice(start).split("\n")) {
    const line = raw.trim();
    // 只看深度 1（顶层成员）；嵌套对象类型里的布尔不是 LoopState 自己的字段
    if (depth === 1 && !isCommentLine(raw)) {
      const m = /^([A-Za-z_$][\w$]*)\??\s*:\s*([^;]+);/.exec(line);
      if (m) {
        const type = m[2]!.replace(/\|\s*undefined/g, "").trim();
        if (type === "boolean" || type === "true" || type === "false") fields.push(m[1]!);
      }
    }
    if (!isCommentLine(raw)) {
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
    }
    // 首行 `export interface LoopState {` 把深度推到 1，回到 0 即接口结束
    if (depth === 0) break;
  }
  return fields;
}

describe("T3a LoopState 布尔标志写入门禁", () => {
  const { writes, fileCount } = scanWrites();
  const byField = (f: string) => writes.filter((w) => w.field === f);

  test("扫描面非空（防止目录或正则写错后恒绿）", () => {
    expect(fileCount).toBeGreaterThan(200);
    // 2026-11-01 起三个 *PendingAfterCompact 的 7×3 处字面置位收口到
    // query/post-compact-flags.ts 的 markPostCompactReinject（3 处），总数从 45 降到 27；
    // 下限随之下调，并改由下一条断言锁住「置真点确实在 helper 里」，防正则写窄后漏扫。
    expect(writes.length).toBeGreaterThan(20);
    expect(byField("hasAttemptedReactiveCompact").some(isTrue)).toBe(true);
    for (const f of [
      "goalReminderPendingAfterCompact",
      "todoReminderPendingAfterCompact",
      "deferredToolsPendingAfterCompact",
    ]) {
      expect(
        byField(f).some((w) => isTrue(w) && w.file.endsWith("query/post-compact-flags.ts")),
      ).toBe(true);
    }
  });

  test("完备性：LoopState 的布尔字段集合 === 分类常量的键集合", () => {
    const parsed = parseLoopStateBooleanFields().sort();
    // 非可选字段必须解析得到，否则正则写窄后会静默漏掉它
    expect(parsed).toContain("hasAttemptedReactiveCompact");
    expect(parsed).toEqual([...FIELDS].sort());
  });

  test("set_only：全仓只许 `= true`", () => {
    const bad = writes.filter(
      (w) =>
        LOOP_STATE_FLAG_KIND[w.field as keyof typeof LOOP_STATE_FLAG_KIND] === "set_only" &&
        !isTrue(w),
    );
    expect(bad.map(fmt)).toEqual([]);
  });

  test("entry_reset：回落只许出现在 beginTurn 函数体内", () => {
    const [from, to] = beginTurnRange();
    const bad = writes.filter(
      (w) =>
        LOOP_STATE_FLAG_KIND[w.field as keyof typeof LOOP_STATE_FLAG_KIND] === "entry_reset" &&
        !isTrue(w) &&
        !(w.file === TURN_COMPLETE_FILE && isFalsy(w) && w.line >= from && w.line <= to),
    );
    expect(bad.map(fmt)).toEqual([]);
  });

  test("pending_consume：回落恰好一处，其余写入只许 `= true`", () => {
    for (const [field, kind] of Object.entries(LOOP_STATE_FLAG_KIND)) {
      if (kind !== "pending_consume") continue;
      const ws = byField(field);
      expect({ field, consumers: ws.filter(isFalsy).map(fmt) }).toEqual({
        field,
        consumers: [expect.any(String)],
      });
      expect({ field, other: ws.filter((w) => !isTrue(w) && !isFalsy(w)).map(fmt) }).toEqual({
        field,
        other: [],
      });
    }
  });

  test("非 tracking 字段都至少有一处置真点（零置真 = 死字段）", () => {
    // 2026-10-30 删掉的 hadHitlThisTurn 就是这个形态：只复位、只读，从不置真
    const dead = Object.entries(LOOP_STATE_FLAG_KIND)
      .filter(([f, kind]) => kind !== "tracking" && !byField(f).some(isTrue))
      .map(([f]) => f);
    expect(dead).toEqual([]);
  });
});
