#!/usr/bin/env bun
/**
 * G2 用例期望守卫（质量防线分层专项总纲 §3.4，M2 遗留两条检查）：
 *
 *   规则 1：同一个 PR 里，某个**已有**用例既改了夹具（用例目录下 case.ts 以外的文件）
 *           又改了期望 → 直接报错，标签也放不行。刷新夹具只许改夹具；夹具一换 G2 就红，
 *           说明要么模型行为变了（期望不该跟着改），要么期望本身该改（单开 PR 讲清楚）。
 *   规则 2：改了**已有**用例的期望 → 必须带 `expect-reviewed` 标签。标签只能由人看过 diff
 *           与 Agent Note 后加；agent 不得给自己的 PR 加（CLAUDE.md）。这条只能做到「可见」，
 *           做不到「强制」：同一个 GitHub 账号技术上也能自己加，靠 PR timeline 追查。
 *
 * 新增用例两条都不管（没有「旧期望」可放宽）。删除用例按规则 2 处理：删掉一个守护等于把期望放到零。
 *
 * 「期望」的口径刻意比 `expect` 字段宽：整份 case.ts 去掉注释、排版与 `mutations` 后的语义文本。
 * - 只比 `expect` 字段会漏掉它引用的顶层常量（X2 的 `UNTRACKED`、X3 的 `MARKER`），也会漏掉
 *   `argv` / `repo` / `settings` 这类改了就能让断言空转的输入。
 * - `mutations` 排除在外：源码一漂移配方就 stale，跟着改 `find` 是例行维护，不放宽任何断言。
 * - 代价：改用例里的 `feature` 文案这种无害改动也要标签。宁可多问一次。
 *
 * 用法：
 *   bun run scripts/smoke/expect-guard.ts                       # 本地：merge-base(origin/main, HEAD)..HEAD
 *   bun run scripts/smoke/expect-guard.ts --base HEAD^1 --head HEAD   # CI：PR 的合并提交
 * 标签从环境变量 `PR_LABELS` 读（JSON 数组，CI 里是 `toJSON(github.event.pull_request.labels.*.name)`）。
 */
import { parseArgs } from "node:util";
import ts from "typescript";

export const CASES_PREFIX = "tests/smoke/cases/";
export const REVIEW_LABEL = "expect-reviewed";

/**
 * case.ts 的语义指纹：去掉注释与排版，并删掉用例对象上的 `mutations` 属性。
 * 用例对象的判据：同时有 `expect` 与 `mutations` 两个属性的对象字面量。
 */
export function caseFingerprint(src: string): string {
  const sf = ts.createSourceFile("case.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const propName = (p: ts.ObjectLiteralElementLike) =>
    p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
  const dropMutations: ts.TransformerFactory<ts.SourceFile> = (ctx) => {
    const visit = (node: ts.Node): ts.Node => {
      if (ts.isObjectLiteralExpression(node)) {
        const names = node.properties.map(propName);
        if (names.includes("expect") && names.includes("mutations")) {
          const kept = node.properties.filter((p) => propName(p) !== "mutations");
          return ts.visitEachChild(
            ctx.factory.updateObjectLiteralExpression(node, kept),
            visit,
            ctx,
          );
        }
      }
      return ts.visitEachChild(node, visit, ctx);
    };
    return (root) => ts.visitNode(root, visit) as ts.SourceFile;
  };
  const out = ts.transform(sf, [dropMutations]);
  const printed = ts.createPrinter({ removeComments: true }).printFile(out.transformed[0]!);
  out.dispose();
  // printer 保留原文的换行与尾逗号：再按 token 重排一遍，排版差异才真的消失
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    printed,
  );
  const tokens: string[] = [];
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
    tokens.push(scanner.getTokenText());
  }
  const closers = new Set(["]", "}", ")"]);
  return tokens.filter((t, i) => !(t === "," && closers.has(tokens[i + 1] ?? ""))).join(" ");
}

export interface CaseChange {
  /** 用例目录名 */
  id: string;
  /** base 上的 case.ts 原文；null = 新增用例 */
  baseCase: string | null;
  /** head 上的 case.ts 原文；null = 用例被删 */
  headCase: string | null;
  /** 用例目录下 case.ts 以外的文件（夹具）有改动 */
  fixtureChanged: boolean;
}

export type Verdict =
  | { id: string; kind: "ok"; reason: string }
  | { id: string; kind: "error"; rule: 1 | 2; reason: string };

export function judge(c: CaseChange, labels: readonly string[]): Verdict {
  if (c.baseCase === null) return { id: c.id, kind: "ok", reason: "新增用例" };
  const expectChanged =
    c.headCase === null || caseFingerprint(c.baseCase) !== caseFingerprint(c.headCase);
  if (!expectChanged) {
    return {
      id: c.id,
      kind: "ok",
      reason: c.fixtureChanged ? "只刷新夹具" : "只改了注释 / 排版 / mutations",
    };
  }
  if (c.fixtureChanged && c.headCase !== null) {
    return {
      id: c.id,
      kind: "error",
      rule: 1,
      reason:
        "同一个 PR 既改了夹具又改了期望。刷新夹具只许改夹具；期望该改就单开 PR（带 Agent Note）",
    };
  }
  if (labels.includes(REVIEW_LABEL)) {
    return { id: c.id, kind: "ok", reason: `期望有改动，已带 ${REVIEW_LABEL}` };
  }
  return {
    id: c.id,
    kind: "error",
    rule: 2,
    reason:
      c.headCase === null
        ? `删除了已有用例，需要人工加 ${REVIEW_LABEL} 标签`
        : `改了已有用例的期望，需要人看过 diff 与 Agent Note 后加 ${REVIEW_LABEL} 标签（agent 不得自己加）`,
  };
}

function git(args: string[], cwd?: string): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString() };
}

function showAt(rev: string, path: string, cwd?: string): string | null {
  const r = git(["show", `${rev}:${path}`], cwd);
  return r.ok ? r.out : null;
}

export function collectChanges(base: string, head: string, cwd?: string): CaseChange[] {
  const diff = git(["diff", "--name-only", "--no-renames", base, head, "--", CASES_PREFIX], cwd);
  if (!diff.ok) throw new Error(`git diff ${base} ${head} 失败：base/head 解析不到`);
  const byCase = new Map<string, { caseTs: boolean; fixture: boolean }>();
  for (const p of diff.out.split("\n").filter(Boolean)) {
    const rest = p.slice(CASES_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash < 0) continue;
    const id = rest.slice(0, slash);
    const e = byCase.get(id) ?? { caseTs: false, fixture: false };
    if (rest.slice(slash + 1) === "case.ts") e.caseTs = true;
    else e.fixture = true;
    byCase.set(id, e);
  }
  return [...byCase].map(([id, e]) => {
    const path = `${CASES_PREFIX}${id}/case.ts`;
    return {
      id,
      baseCase: showAt(base, path, cwd),
      headCase: showAt(head, path, cwd),
      fixtureChanged: e.fixture,
    };
  });
}

function parseLabels(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { base: { type: "string" }, head: { type: "string" } },
  });
  const head = values.head ?? "HEAD";
  let base = values.base;
  if (!base) {
    // 与 change-scope 同一口径：相对 merge-base 取，否则会把 main 上别人的提交算成你的改动
    const mb = git(["merge-base", "origin/main", head]);
    if (!mb.ok) {
      console.error("expect-guard: 解析不到 merge-base(origin/main, HEAD)，请显式传 --base");
      process.exit(2);
    }
    base = mb.out.trim();
  }
  const labels = parseLabels(process.env.PR_LABELS);
  const verdicts = collectChanges(base, head).map((c) => judge(c, labels));
  for (const v of verdicts) {
    const tag = v.kind === "ok" ? "OK   " : `规则${v.rule}`;
    console.log(`[${tag}] ${v.id}：${v.reason}`);
  }
  const errors = verdicts.filter((v) => v.kind === "error");
  if (verdicts.length === 0) console.log("expect-guard: 本次没有改动 G2 用例");
  if (errors.length > 0) {
    console.error(`expect-guard: ${errors.length} 个用例未通过（见总纲 §3.4）`);
    process.exit(1);
  }
}
