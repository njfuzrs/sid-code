#!/usr/bin/env bun
/**
 * 渲染底座行为契约校验（B9 / T0.3）。
 *
 * `packages/cli/src/ui/render-port/SPEC.md` 是换底座时「不许退步」的规格。规格的失败模式是
 * **写了没测**：契约列在那里，测试名对不上或文件被删了，大家以为有保护，其实没有。
 * 这个脚本把「每条契约都有测试或明确的待办」从纪律变成检查：
 *
 * 1. 每行契约格式合法：ID 属于闭集分组、全文唯一，来源非空。
 * 2. 测试列是已有测试时：文件存在，且包含给出的片段（测试名或 `ID:` 前缀）。
 * 3. 测试列是待办时：只能是 `⏳ T0.5`（端口契约测试）或 `⏳ T<x.y>`（x ≥ 1，要等后续任务，如真实 PTY）。
 *    T0.4 已落地，`⏳ T0.4 …` 不再合法 —— 场景契约直接引用 `term-bench/scenarios.tsx` 的 `S<n>: {`。
 * 4. 反向：`packages/cli/tests/render-port/` 里以 `"<ID>: "` 开头的测试名，ID 必须在 SPEC 里存在
 *    （防止契约改名 / 删掉后测试成了孤儿）。
 *
 * 用法：
 *   bun run tui:spec            # 校验，失败退 1
 *   bun run tui:spec --report   # 额外打印覆盖率（已测 / 待 T0.5 / 待后续任务，按分组）
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
export const SPEC_PATH = join(ROOT, "packages/cli/src/ui/render-port/SPEC.md");
export const PORT_TESTS_DIR = join(ROOT, "packages/cli/tests/render-port");

/** 分组闭集。加分组先改这里，再改 SPEC.md 的「格式」段。 */
export const GROUPS = ["R", "L", "T", "I", "M", "O", "E", "X", "P"] as const;

export interface Contract {
  id: string;
  group: string;
  behavior: string;
  source: string;
  test: string;
  line: number;
}

export type TestRef =
  | { kind: "existing"; file: string; fragment: string }
  | { kind: "pending-contract" }
  | { kind: "pending-later"; task: string };

const ID_RE = new RegExp(`^(${GROUPS.join("|")})(\\d+)([a-z]?)$`);

/** 只取四列且首列像 ID 的表格行。模式归属表之类的辅助表首列不是 ID，自然跳过。 */
export function parseSpec(md: string): Contract[] {
  const out: Contract[] = [];
  md.split("\n").forEach((raw, idx) => {
    if (!raw.startsWith("| ")) return;
    // 按「未转义的 |」切分
    const cells = raw
      .slice(1, raw.endsWith("|") ? -1 : undefined)
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
    if (cells.length !== 4) return;
    const [id, behavior, source, test] = cells as [string, string, string, string];
    if (!/^[A-Z]\d/.test(id)) return; // 表头 / 分隔行 / 辅助表
    out.push({ id, group: id[0]!, behavior, source, test, line: idx + 1 });
  });
  return out;
}

export function parseTestRef(cell: string): TestRef | { kind: "invalid"; reason: string } {
  if (cell === "⏳ T0.5") return { kind: "pending-contract" };
  const later = /^⏳ (T[1-9]\d*\.\d+)$/.exec(cell);
  if (later) return { kind: "pending-later", task: later[1]! };
  if (/^⏳ T0\./.test(cell)) {
    return {
      kind: "invalid",
      reason:
        "阶段 0 只剩 T0.5 能挂待办（T0.4 场景请直接引用 term-bench/scenarios.tsx 的 `S<n>: {`）",
    };
  }
  const existing = /^`([^`]+)`\s+(.+)$/.exec(cell);
  if (existing) return { kind: "existing", file: existing[1]!, fragment: existing[2]!.trim() };
  return {
    kind: "invalid",
    reason: "测试列只能是 `文件` 片段 / ⏳ T0.5 / ⏳ T<x.y>（x ≥ 1）",
  };
}

/** 端口测试里以 `"<ID>: "` 开头的测试名（test / it / describe 都算）。 */
export function extractTestIds(content: string): string[] {
  const ids: string[] = [];
  for (const m of content.matchAll(
    /\b(?:test|it|describe)(?:\.\w+)?\(\s*["'`]([A-Z]\d+[a-z]?):\s/g,
  )) {
    ids.push(m[1]!);
  }
  return ids;
}

function collectTests(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) collectTests(f, out);
    else if (/\.test\.tsx?$/.test(e)) out.push(f);
  }
  return out;
}

export interface Verdict {
  contracts: Contract[];
  errors: string[];
}

export function verify(md: string, opts: { root?: string; portTestsDir?: string } = {}): Verdict {
  const root = opts.root ?? ROOT;
  const portTestsDir = opts.portTestsDir ?? PORT_TESTS_DIR;
  const contracts = parseSpec(md);
  const errors: string[] = [];
  const seen = new Map<string, number>();

  // 防空转：一个契约都没解析出来，多半是格式变了，脚本却会全绿
  if (contracts.length === 0)
    errors.push("SPEC.md 里一条契约都没解析到 —— 表格格式变了还是文件空了？");
  for (const g of GROUPS) {
    if (!contracts.some((c) => c.group === g)) errors.push(`分组 ${g} 没有任何契约`);
  }

  for (const c of contracts) {
    const at = `SPEC.md:${c.line} ${c.id}`;
    if (!ID_RE.test(c.id)) errors.push(`${at}：ID 格式不对或分组不在闭集 ${GROUPS.join("/")} 里`);
    if (seen.has(c.id)) errors.push(`${at}：ID 重复（首次出现在第 ${seen.get(c.id)} 行）`);
    else seen.set(c.id, c.line);
    if (!c.behavior) errors.push(`${at}：行为为空`);
    if (!c.source) errors.push(`${at}：来源为空 —— 说不出来源的契约不许写`);

    const ref = parseTestRef(c.test);
    if (ref.kind === "invalid") {
      errors.push(`${at}：${ref.reason}（实际：${c.test || "空"}）`);
    } else if (ref.kind === "existing") {
      const abs = join(root, ref.file);
      if (!existsSync(abs)) {
        errors.push(`${at}：测试文件不存在 ${ref.file}`);
      } else if (!readFileSync(abs, "utf8").includes(ref.fragment)) {
        errors.push(`${at}：${ref.file} 里找不到片段「${ref.fragment}」`);
      }
    }
  }

  // 反向：端口测试里的 ID 必须在 SPEC 里
  for (const f of collectTests(portTestsDir)) {
    for (const id of extractTestIds(readFileSync(f, "utf8"))) {
      if (!seen.has(id))
        errors.push(`${relative(root, f)}：测试引用的契约 ${id} 不在 SPEC.md 里（孤儿测试）`);
    }
  }
  return { contracts, errors };
}

export function coverage(contracts: Contract[]) {
  const rows = GROUPS.map((g) => {
    const cs = contracts.filter((c) => c.group === g);
    const kinds = cs.map((c) => parseTestRef(c.test).kind);
    return {
      group: g,
      total: cs.length,
      tested: kinds.filter((k) => k === "existing").length,
      contract: kinds.filter((k) => k === "pending-contract").length,
      later: kinds.filter((k) => k === "pending-later").length,
    };
  });
  return rows;
}

if (import.meta.main) {
  const { contracts, errors } = verify(readFileSync(SPEC_PATH, "utf8"));
  if (process.argv.includes("--report")) {
    console.log("分组  总数  已测  待T0.5  待后续");
    for (const r of coverage(contracts)) {
      console.log(
        `${r.group.padEnd(4)} ${String(r.total).padStart(5)} ${String(r.tested).padStart(5)} ${String(r.contract).padStart(7)} ${String(r.later).padStart(7)}`,
      );
    }
  }
  if (errors.length > 0) {
    console.error(`❌ SPEC.md 校验失败（${errors.length} 处）：`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  const tested = contracts.filter((c) => parseTestRef(c.test).kind === "existing").length;
  console.log(`✅ SPEC.md ${contracts.length} 条契约格式合规，其中 ${tested} 条已有测试。`);
}
