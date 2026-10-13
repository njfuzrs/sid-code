#!/usr/bin/env bun
/**
 * tsc 增量门禁（「不新增」棘轮）。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 *
 * 2026-10-13 的质量报告复核确认：`tsc --noEmit` 有 107 处存量错误，而 CI 刻意不含
 * 类型检查 —— 这是唯一一条还在持续恶化、却没有任何东西会报警的曲线。
 * 但直接把 `tsc --noEmit` 接进 CI 会恒红（存量不清零就永远红），
 * 恒红的门禁等于没有门禁：最后一定被人绕过或删掉。
 *
 * 所以与 `scripts/command-system-gate.ts` 用同一套棘轮：存量错误进基线，**只拦新增**，
 * 修掉存量后允许（且提示）收紧基线。数字只能降不能升。
 *
 * ── 三条刻意的设计（每条都有踩坑教训）────────────────────────────────
 *
 * 1. **身份键不含行号列号**：在错误上方插一行代码会让它后面所有错误的行号漂移，
 *    带行号的门禁会因此大面积假报，然后人就会去绕过它。
 *    键 = 归一化文件路径 + 错误码 + 归一化消息。
 * 2. **用计数比较而不是集合比较**：同一文件里出现第二个完全相同的错误，
 *    集合比较发现不了。基线存 `{ 键: 出现次数 }`。
 * 3. **消息归一化**：错误消息里会出现 node_modules 的绝对路径，而这段路径
 *    在 worktree（`.bun/` 直接住在仓库 node_modules 下）与 CI（`/home/runner/...`）
 *    上完全不同 —— 不归一化，同一份代码在两台机器上产出的键就不一样，CI 必红。
 *
 * ── 环境对齐：跑 tsc 前临时补齐 vendor 快照 ──────────────────────────
 *
 * `packages/core/vendor/model-catalog-snapshot.json` 是 **gitignore 的构建产物**
 * （`make build` 的目标之一）：CI 的 fresh clone 上没有它，本地跑过 `make build` 则有。
 * 缺文件时 tsc 会对 `model-catalog-snapshot-embedded.ts` 的 import 多报一条 TS2307，
 * 于是同一个仓库在 CI 与本地看到**不同的错误集合**，棘轮必然在其中一边假报「新增」。
 *
 * 所以跑 tsc 前若该文件缺失，临时写一个空占位（该模块只把文件路径当字符串导出，
 * 内容不参与类型检查），跑完立即删除，让两边看到同一个集合。
 * **这不是掩盖真实错误**：import 路径写错、生成脚本坏掉这类问题依旧会照常报出来，
 * 被屏蔽的只是「构建产物尚未生成」这个纯环境状态。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────
 *
 *   bun run typecheck:gate                     # 校验（有新增则退 1）
 *   bun run typecheck:gate --update-baseline   # 收紧基线（只允许收紧）
 *   bun run typecheck:gate --init              # 无条件写基线
 *
 * ⚠️ `--init` **仅首次生成基线时用**。日常收紧走 `--update-baseline`：
 * 它只允许「每个键的次数不增、且不出现新键」，放宽直接退 1。
 * 允许放宽的话，棘轮就成了摆设 —— 新增一处错误顺手把基线调高，门禁全程绿。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BASELINE_PATH = join(import.meta.dir, "tsc-baseline.json");
const TSC_BIN = join(ROOT, "node_modules", ".bin", "tsc");
const SNAPSHOT_PATH = join(ROOT, "packages/core/vendor/model-catalog-snapshot.json");

const BASELINE_NOTE = [
  "tsc 存量错误基线（由 scripts/tsc-baseline.ts 维护）。",
  "门禁只拦新增、允许收紧：新增的错误必须修掉，不许调高数字；",
  "存量清理之后跑 bun run typecheck:gate --update-baseline 收紧。",
  "键 = 归一化文件路径 + 错误码 + 归一化消息（不含行列号，行号漂移不触发门禁），值 = 出现次数。",
  "换 tsc 版本或大改依赖树之后错误集合可能变，需要重新 --init 并在 PR 里说明总数变化。",
].join("");

/** 基线文件 schema。 */
export interface Baseline {
  /** 生成基线时的 tsc 版本；与当前不一致时 check 模式只警告、不报红。 */
  tscVersion: string;
  /** 生成基线时的错误总数（用于打印，不参与判定）。 */
  total: number;
  /** 给下一个人看的说明。 */
  note: string;
  /** 身份键 → 出现次数。 */
  errors: Record<string, number>;
}

/** 一条已归一化的类型错误。 */
export interface TscError {
  /** 归一化后的文件路径（仓库根被替换成 `<root>`，node_modules 前缀替换成 `<nm>/`）。 */
  file: string;
  /** 错误码，如 TS2322。 */
  code: string;
  /** 归一化后的消息（不含 `error TSxxxx:` 前缀）。 */
  message: string;
  line: number;
  column: number;
  /** 身份键：`文件|错误码|消息`，不含行列号。 */
  key: string;
}

/** 与基线的比较结果。 */
export interface DiffResult {
  /** 次数超过基线的键（新键或同键次数变多）。 */
  added: Array<{ error: TscError; currentCount: number; baselineCount: number }>;
  /** 计数低于基线的键（含已归零的）——「可收紧」的来源。 */
  tightened: string[];
  currentTotal: number;
  baselineTotal: number;
}

/** tsc 的错误行格式：`<path>(<line>,<col>): error TS<code>: <message>`。 */
const ERROR_LINE_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/**
 * 归一化一段文本（文件路径或错误消息）里的环境相关片段。
 *
 * 顺序按「先吃掉 node_modules 前缀、再替换仓库根、最后统一分隔符」。
 * node_modules 正则用惰性匹配而非「仓库根前缀替换」：worktree 里 node_modules
 * 会向上解析到别的目录树，只替换仓库根两边对不上，会产出一批假的「新增错误」。
 */
export function normalizeForCompare(text: string, root: string): string {
  return text
    .replace(/(?:[A-Za-z]:)?[^'"\s]*?\/node_modules\//g, "<nm>/")
    .split(root)
    .join("<root>")
    .replace(/\\/g, "/");
}

/**
 * 解析 tsc 的 `--pretty false` 输出。
 *
 * 只认错误行本身；缩进的补充说明行（tsc 会跟在错误后面）与 `Found N errors` 之类的
 * 汇总行都不匹配正则，天然被丢弃 —— 这正是「只取每条错误的第一行」。
 */
export function parseTscOutput(text: string, root: string): TscError[] {
  const out: TscError[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = ERROR_LINE_RE.exec(raw);
    if (!m) continue;
    const [, rawFile, lineStr, colStr, code, rawMessage] = m;
    const file = normalizeForCompare(rawFile, root);
    const message = normalizeForCompare(rawMessage, root);
    out.push({
      file,
      code,
      message,
      line: Number(lineStr),
      column: Number(colStr),
      key: `${file}|${code}|${message}`,
    });
  }
  return out;
}

/** 按身份键统计出现次数。 */
export function countByKey(errors: TscError[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of errors) counts[e.key] = (counts[e.key] ?? 0) + 1;
  return counts;
}

/** 当前错误集合与基线的差异。判定只看 added：非空即「有新增」。 */
export function diffAgainstBaseline(current: TscError[], baseline: Baseline): DiffResult {
  const counts = countByKey(current);
  const added: DiffResult["added"] = [];
  for (const key of Object.keys(counts).sort()) {
    const baselineCount = baseline.errors[key] ?? 0;
    if (counts[key] > baselineCount) {
      // 打印用该键的第一条错误（行号取当次运行的真实值，方便定位）。
      const error = current.find((e) => e.key === key);
      if (error) added.push({ error, currentCount: counts[key], baselineCount });
    }
  }
  const tightened = Object.keys(baseline.errors)
    .filter((k) => (counts[k] ?? 0) < baseline.errors[k])
    .sort();
  return { added, tightened, currentTotal: current.length, baselineTotal: baseline.total };
}

/**
 * 解析结果为 0 条、但 tsc 退出码不为 0 → 脚本自身故障，不能判为通过。
 *
 * 这是本仓踩过很多次的形态：解析器与上游输出格式脱节，扫出空集，然后全程绿。
 * 宁可报故障（exit 2），也不能把「零命中」当成「没有新增」。
 */
export function looksLikeParserFailure(parsedCount: number, exitCode: number): boolean {
  return parsedCount === 0 && exitCode !== 0;
}

/** 键按字母排序写出，保证基线文件的 diff 稳定。 */
function sortCounts(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(counts).sort()) out[k] = counts[k];
  return out;
}

/**
 * 跑 tsc 前补齐 gitignore 的 vendor 快照占位（返回「占位是否由本进程创建」）。
 *
 * 理由见文件头「环境对齐」一节：该文件的有无会让 CI 与本地看到不同的错误集合。
 * 只补不删会把空占位留在工作区（后续 `bun build --compile` 会把它打进产物，
 * 冷启动的模型目录退化成空），所以主流程必须在 finally 里删掉本进程创建的那一份。
 */
function ensureSnapshotPlaceholder(): boolean {
  if (existsSync(SNAPSHOT_PATH)) return false;
  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify({ generatedAt: 0, models: {} }));
  return true;
}

/** 跑一次 `tsc --noEmit`，返回合并后的输出与退出码。 */
function runTsc(): { text: string; code: number } {
  const placeholderCreated = ensureSnapshotPlaceholder();
  try {
    const proc = spawnSync(TSC_BIN, ["--noEmit", "--pretty", "false"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return { text: `${proc.stdout ?? ""}${proc.stderr ?? ""}`, code: proc.status ?? 1 };
  } finally {
    if (placeholderCreated) rmSync(SNAPSHOT_PATH, { force: true });
  }
}

/** 当前 tsc 版本（不含前导 `Version `）。 */
function readTscVersion(): string {
  const proc = spawnSync(TSC_BIN, ["--version"], { cwd: ROOT, encoding: "utf8" });
  return (proc.stdout ?? "").trim().replace(/^Version\s+/, "");
}

function readBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) {
    console.error(`✗ 基线文件不存在：${BASELINE_PATH}`);
    console.error("  首次接入跑 bun run typecheck:gate --init 生成（仅首次使用）。");
    process.exit(2);
  }
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

function writeBaseline(baseline: Baseline): void {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
}

function main(): void {
  const args = process.argv.slice(2);
  const init = args.includes("--init");
  const update = args.includes("--update-baseline");

  const tscVersion = readTscVersion();
  const { text, code } = runTsc();
  const errors = parseTscOutput(text, ROOT);

  if (looksLikeParserFailure(errors.length, code)) {
    console.error("✗ tsc 退出码非 0，却没有解析出任何错误行 —— 解析器可能已与 tsc 输出格式脱节。");
    console.error("  宁可报故障，也不能把「零命中」当成「没有新增」（本仓发生过多次）。");
    console.error(`  tsc 原始输出前 500 字符：\n${text.slice(0, 500)}`);
    process.exit(2);
  }

  if (init) {
    writeBaseline({
      tscVersion,
      total: errors.length,
      note: BASELINE_NOTE,
      errors: sortCounts(countByKey(errors)),
    });
    console.log(`类型检查棘轮（tsc ${tscVersion}）`);
    console.log(`✓ 基线已写入：${errors.length} 处错误 → scripts/tsc-baseline.json`);
    return;
  }

  const baseline = readBaseline();
  const diff = diffAgainstBaseline(errors, baseline);

  console.log(`类型检查棘轮（tsc ${tscVersion}）`);
  console.log(`  当前 ${errors.length} 处错误 / 基线 ${baseline.total} 处`);

  if (update) {
    if (diff.added.length > 0) {
      console.error(`\n✗ --update-baseline 只允许收紧：有 ${diff.added.length} 项次数超过基线。`);
      printAdded(diff);
      console.error("\n  放宽基线等于取消门禁。先把新增的错误修掉，再来收紧。");
      process.exit(1);
    }
    writeBaseline({
      tscVersion,
      total: errors.length,
      note: BASELINE_NOTE,
      errors: sortCounts(countByKey(errors)),
    });
    console.log(`✓ 基线已收紧：${baseline.total} → ${errors.length} 处。`);
    return;
  }

  if (baseline.tscVersion !== tscVersion) {
    console.warn(
      `⚠ 基线记录的 tsc 版本是 ${baseline.tscVersion}，当前是 ${tscVersion}：` +
        "错误集合可能已经变化。升级 tsc 后请重跑 --init 并在 PR 里说明总数变化（这是刻意保留的人工步骤）。",
    );
  }

  if (diff.added.length > 0) {
    console.error(`\n✗ 新增 ${diff.added.length} 项类型错误：`);
    printAdded(diff);
    console.error(
      "\n  修掉它，不要放宽基线；存量清理后跑 bun run typecheck:gate --update-baseline 收紧。",
    );
    process.exit(1);
  }

  if (diff.tightened.length > 0) {
    console.log(`  ↓ 比基线少 ${diff.tightened.length} 项`);
    console.log("  可收紧：跑 bun run typecheck:gate --update-baseline 收紧基线。");
  }
  console.log("\n✓ 无新增类型错误。");
}

function printAdded(diff: DiffResult): void {
  for (const a of diff.added) {
    const suffix = a.baselineCount > 0 ? `（同键 ${a.baselineCount} → ${a.currentCount} 次）` : "";
    console.error(
      `  - ${a.error.file}(${a.error.line},${a.error.column}): ${a.error.code}: ${a.error.message}${suffix}`,
    );
  }
}

if (import.meta.main) main();
