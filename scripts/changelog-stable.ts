/**
 * scripts/changelog-stable.ts — beta 泡制期「一修一号」流程的命令行入口（T1 / T3 / T5）。
 *
 * 用法：
 *   bun run scripts/changelog-stable.ts merge <当前stable|-> <目标版本> [--write]
 *       合并 (当前stable, 目标] 区间的 curated，打印合并稿；--write 落到
 *       changelog/curated/stable/v<目标>.json。区间只有一个版本时打印 __SINGLE__ 并不写文件
 *       （快车道零行为变化）。
 *   bun run scripts/changelog-stable.ts beta-note <版本> "<一句话>"
 *       为 beta 修复号写最小形态 curated（betaOnly:true / userFacing:false）。已存在则拒绝覆盖。
 *   bun run scripts/changelog-stable.ts backlog <stable|-> <beta|->
 *       只读：打印 stable → beta 之间积压的 beta 号与各自摘要。
 *
 * 全部是确定性的本地文件操作：**不调 LLM、不联网、不碰服务器**
 * （发布路径禁令，见 CLAUDE.md「Changelog + Tag」五条禁令）。
 *
 * 测试可用 SID_CHANGELOG_CURATED_DIR 把 curated 目录重定向到 tmpdir。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, listSemverTags } from "./lib/changelog-git.ts";
import {
  validateCurated,
  toRenderSections,
  type CuratedEntry,
} from "./lib/changelog-curated-schema.ts";
import {
  describeBacklog,
  mergeStableNotes,
  versionsInRange,
  type StableNotes,
} from "./lib/changelog-stable.ts";

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export function curatedDir(): string {
  return process.env.SID_CHANGELOG_CURATED_DIR || resolve(ROOT, "changelog/curated");
}

export function stableDir(): string {
  return resolve(curatedDir(), "stable");
}

/** curated 目录里出现过的全部版本号（文件名派生） */
export function listCuratedVersions(dir: string = curatedDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^v(\d+\.\d+\.\d+)\.json$/.exec(f)?.[1])
    .filter((v): v is string => !!v);
}

/** 读并校验一份 curated；缺失或不合规返回错误字符串 */
export function readCurated(version: string, dir: string = curatedDir()): CuratedEntry | string {
  const p = resolve(dir, `v${version}.json`);
  if (!existsSync(p)) return `缺 curated 文案：${p}`;
  let obj: unknown;
  try {
    obj = JSON.parse(readFileSync(p, "utf-8"));
  } catch (err: any) {
    return `v${version}.json 解析失败：${err?.message ?? err}`;
  }
  const errs = validateCurated(obj, version);
  if (errs.length > 0) return `v${version}.json 不合规：${errs.join("；")}`;
  return obj as CuratedEntry;
}

/** 读全部稳定版说明（官网 / Release / 校验器共用） */
export function readStableNotes(dir: string = stableDir()): StableNotes[] {
  if (!existsSync(dir)) return [];
  const out: StableNotes[] = [];
  for (const f of readdirSync(dir)) {
    if (!/^v\d+\.\d+\.\d+\.json$/.test(f)) continue;
    try {
      const obj = JSON.parse(readFileSync(resolve(dir, f), "utf-8"));
      if (Array.isArray(obj.covers) && validateCurated(obj, obj.version).length === 0) {
        out.push(obj as StableNotes);
      }
    } catch {
      /* 坏文件由 changelog:check 报，这里不让一份坏文件拖垮整条读路径 */
    }
  }
  return out;
}

function printEntry(e: CuratedEntry): void {
  if (e.highlight) console.log(`  ★ ${e.highlight}`);
  if (!e.userFacing) console.log("  （无用户可见变更）");
  for (const s of toRenderSections(e.sections)) {
    console.log(`  【${s.title}】`);
    for (const it of s.items) console.log(`    - ${it}`);
  }
}

function cmdMerge(argv: string[]): number {
  const [fromArg, to] = argv;
  const write = argv.includes("--write");
  if (!to || !SEMVER_RE.test(to) || !fromArg || (fromArg !== "-" && !SEMVER_RE.test(fromArg))) {
    console.error("用法: changelog-stable.ts merge <当前stable|-> <目标版本> [--write]");
    return 1;
  }
  const from = fromArg === "-" ? null : fromArg;
  const candidates = [
    ...listCuratedVersions(),
    ...listSemverTags().map((t) => t.replace(/^v/, "")),
  ];
  const range = versionsInRange(candidates, from, to);

  const entries: CuratedEntry[] = [];
  const missing: string[] = [];
  for (const v of range) {
    const e = readCurated(v);
    if (typeof e === "string") missing.push(e);
    else entries.push(e);
  }
  if (missing.length > 0) {
    for (const m of missing) console.error(`  ❌ ${m}`);
    console.error("  区间内每个版本都必须有合规的 curated，否则合并稿会静默漏掉那一版的变更");
    return 1;
  }

  const merged = mergeStableNotes(entries, to);
  if (!("covers" in merged)) {
    // 快车道：区间只有目标自己，稳定版说明 = 原 curated，不产出新文件
    console.log("__SINGLE__");
    return 0;
  }

  console.log(`  稳定版说明合并稿：v${from ?? "?"} → v${to}，覆盖 ${merged.covers.join(" / ")}`);
  const dropped = entries.filter((e) => e.betaOnly).map((e) => `v${e.version}`);
  if (dropped.length > 0) console.log(`  已丢弃 beta-only 修复号：${dropped.join(" ")}`);
  printEntry(merged);

  if (write) {
    mkdirSync(stableDir(), { recursive: true });
    const p = resolve(stableDir(), `v${to}.json`);
    writeFileSync(p, JSON.stringify(merged, null, 2) + "\n");
    console.log(`__WROTE__ ${p}`);
  }
  return 0;
}

function cmdBetaNote(argv: string[]): number {
  const [version, ...rest] = argv;
  const note = rest.join(" ").trim();
  if (!version || !SEMVER_RE.test(version) || !note) {
    console.error('用法: changelog-stable.ts beta-note <版本> "<一句话说明>"');
    return 1;
  }
  const p = resolve(curatedDir(), `v${version}.json`);
  if (existsSync(p)) {
    console.error(`  ❌ ${p} 已存在，拒绝覆盖（人工过目过的文案不能被一句 beta-note 冲掉）`);
    return 1;
  }
  const entry = {
    version,
    userFacing: false,
    betaOnly: true,
    betaNote: note,
    highlight: null,
    sections: [],
    commits: [],
    generatedBy: "beta-note",
  };
  const errs = validateCurated(entry, version);
  if (errs.length > 0) {
    for (const e of errs) console.error(`  ❌ ${e}`);
    return 1;
  }
  mkdirSync(curatedDir(), { recursive: true });
  writeFileSync(p, JSON.stringify(entry, null, 2) + "\n");
  console.log(`__WROTE__ ${p}`);
  return 0;
}

function cmdBacklog(argv: string[]): number {
  const [s, b] = argv;
  const stable = s && s !== "-" && SEMVER_RE.test(s) ? s : null;
  const beta = b && b !== "-" && SEMVER_RE.test(b) ? b : null;
  const candidates = [
    ...listCuratedVersions(),
    ...listSemverTags().map((t) => t.replace(/^v/, "")),
  ];
  const lines = describeBacklog(stable, beta, candidates, (v) => {
    const e = readCurated(v);
    return typeof e === "string" ? undefined : e;
  });
  for (const l of lines) console.log(`  ${l}`);
  return 0;
}

function main(): number {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "merge":
      return cmdMerge(rest);
    case "beta-note":
      return cmdBetaNote(rest);
    case "backlog":
      return cmdBacklog(rest);
    default:
      console.error("用法: changelog-stable.ts <merge|beta-note|backlog> ...（见文件头）");
      return 1;
  }
}

if (import.meta.main) process.exit(main());
