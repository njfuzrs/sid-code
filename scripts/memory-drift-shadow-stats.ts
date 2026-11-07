#!/usr/bin/env bun
/**
 * memory-drift-shadow-stats —— 记忆漂移与维护方案的影子统计（2026-11-07）
 *
 * 对应方案：docs-research/sid-code/bugfixes/todo/20261102-07H2-漂移与维护-落地方案.md
 *
 * ## 它回答什么
 *
 * **T2（索引年龄标注稀疏化）** 的方案写「先影子统计 7 / 30 两档在各目录的覆盖率，
 * 目标是覆盖率 ≤30%」，但没说清分母。这里的答案是**索引行口径**：`annotateIndexAges`
 * 只处理 `MEMORY.md` 里实际存在的条目行，截断线外的文件根本不注入，把它们算进分母
 * 会系统性低估覆盖率。文件口径同时给出，作为「不截断时会是多少」的参考值。
 *
 * **T3（锚点失效检测）** 要先知道误报面：记忆正文里的仓内相对路径，有多少条记忆是
 * **全部不存在**（这类才会被标 ⚠）、多少是**部分不存在**（方案明确不标）、多少全在。
 * 「全部不存在」里还混着「整条记忆都在讲别的仓库」——这是已知误报来源，所以输出
 * 附样例，由人判断值不值得上线，而不是让脚本替人下结论。
 *
 * ## 三条口径（口径变了要一起改，别只改一半）
 *
 * 1. 年龄走 `memoryAgeDays`（`freshness.ts` 的真实实现，与 `buildFreshnessWarning`
 *    同源）；索引行正则与 `annotateIndexAges`（`store.ts`）逐字一致。
 * 2. 锚点只认「含 `/`、带 1–6 位扩展名、不以 `/` 或 `~` 开头」的 token。行号后缀
 *    `:556` 剥掉再判。绝对路径、URL、`node_modules/` 下的路径一律不算。
 * 3. 锚点存在性只对 `--root` 指定的仓库判断。**引用别的仓库的相对路径会被判成失效**
 *    —— 这是设计上的已知误报，靠「部分不存在不标」+ 人看样例兜住。
 *
 * 4. **一个路径可能在多个根下**。monorepo 的记忆常写成包内相对路径（`src/api/x.ts`），
 *    实际在 `anka-app/packages/ontology-studio/src/api/x.ts`。`--extra-root` 可重复，
 *    任一根命中即算存在。只给仓库根会把这类全判成失效（iam-studio-fe 实测 37/38）。
 *
 * ## 用法
 *
 *   bun run scripts/memory-drift-shadow-stats.ts               # 当前仓库项目记忆 + 全局记忆
 *   bun run scripts/memory-drift-shadow-stats.ts --root <仓库>  # 指定仓库根（锚点按它判存在）
 *   bun run scripts/memory-drift-shadow-stats.ts --root <仓库> \
 *     --extra-root <子包根>                                     # monorepo：包内相对路径的候选根
 *   bun run scripts/memory-drift-shadow-stats.ts --all          # 再扫 ~/.sid-code/projects/<key>/memory
 *   bun run scripts/memory-drift-shadow-stats.ts --json
 *
 * 没有 `--root` 时用 cwd 当仓库根；`--all` 且没给根时不跑锚点检测
 * （宁可不报，也不拿错根判一堆假失效）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { memoryAgeDays } from "@sid-code/core/memory/freshness.ts";
import { resolveProjectRoot, sanitizeProjectKey } from "@sid-code/core/memory/paths.ts";
import { readMemoryFrontmatter, stripFrontmatter } from "@sid-code/core/memory/scan.ts";

/**
 * 四档阈值：1 天是当前实现，7 / 30 是方案待选的两档，90 是兜底档。
 *
 * 为什么要有 90：实测 7 天与 30 天两档在 iam-studio-fe 上分别是 90.6% / 63.8%，
 * 都远超方案设的「覆盖率 ≤30%」。没有更高一档，就无法回答「N 取多少才达标」。
 */
export const AGED_THRESHOLDS = [1, 7, 30, 90] as const;

/** 与 `store.ts` 的 `annotateIndexAges` 逐字一致：只认 `- [key](file) desc` 这种条目行 */
const INDEX_LINE_RE = /^\s*-\s*\[([^\]]*)\]\([^)]*\)/;

/**
 * 仓内相对路径的保守提取。
 *
 * 逐条排除的都是实测见过的误报来源：
 * - 绝对路径（`/Users/...`）与 `~/...`：token 首段前面就是分隔符，已被 lookbehind 挡掉；
 * - URL（`https://github.com/a/b.ts`）：`github.com/a/b.ts` 前面是 `/`，同样被挡；
 * - `node_modules/` 下的路径：依赖包路径没有"锚点"语义，仓库升级就会失效；
 * - 裸文件名（`store.ts`）：没有 `/` 就无法确定是哪个目录，宁可漏报。
 *
 * 行号后缀（`:556`、`:12-18`）在捕获组外，天然不会被带进路径。
 */
const REPO_PATH_RE =
  /(?<![\w.\-~:\/])((?:[\w.@-]+\/)+[\w.@-]+\.[a-zA-Z]{1,6})(?::\d+(?:[-,]\d+)?)?/g;

/** 纯函数：正文 → 去重排序后的仓内相对路径。单测直接测它。 */
export function extractRepoPaths(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(REPO_PATH_RE)) {
    const p = m[1];
    if (/^(?:https?|ftp):/.test(p) || p.includes("://")) continue;
    if (p.includes("node_modules/")) continue;
    out.add(p);
  }
  return [...out].sort();
}

export interface AgeBucket {
  /** 阈值（天） */
  threshold: number;
  /** 年龄 ≥ 阈值的条目数 */
  aged: number;
  /** 参与统计的条目总数（分母） */
  total: number;
  /** aged / total；total 为 0 时记 0（不是 NaN，输出要能直接排序比较） */
  ratio: number;
}

/** 纯函数：年龄数组 → 各阈值下的覆盖率。单测直接测它。 */
export function bucketizeAges(
  ages: number[],
  thresholds: readonly number[] = AGED_THRESHOLDS,
): AgeBucket[] {
  return thresholds.map((threshold) => {
    const aged = ages.filter((d) => d >= threshold).length;
    return { threshold, aged, total: ages.length, ratio: ages.length ? aged / ages.length : 0 };
  });
}

/**
 * 项目记忆目录名的派生**直接复用内核实现**，不自己写一份 sanitize。
 *
 * 理由：路径含非 ASCII 字符时 `sanitizeProjectKey` 会追加 6 位哈希后缀保证单射
 * （`paths.ts` 审计第 3 条）。自己实现的版本在中文目录下会算出另一个目录名，
 * 统计静默落在空目录上 —— 表现为「这个项目一条记忆都没有」，而不是报错。
 * 同理先过 `resolveProjectRoot`：worktree 里的 cwd 要规范到主仓根才对得上。
 */
export function projectKeyFor(root: string): string {
  return sanitizeProjectKey(resolveProjectRoot(root));
}

/** 一条记忆的统计单元：判定 T2 只需 updated，判定 T3 才去读 file */
interface MemEntry {
  key: string;
  updated: number;
  file: string;
}

/** 目录下的记忆文件（不含 MEMORY.md 索引、不含 `archive/` 这类子目录、不含点文件） */
function listMemoryFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (d) =>
          d.isFile() && d.name.endsWith(".md") && d.name !== "MEMORY.md" && !d.name.startsWith("."),
      )
      .map((d) => join(dir, d.name));
  } catch {
    return [];
  }
}

/** 读一个记忆目录：条目列表 + 索引里实际列出的 key 序列 */
function loadMemoryDir(dir: string): { entries: MemEntry[]; indexKeys: string[] } {
  const entries: MemEntry[] = [];
  for (const file of listMemoryFiles(dir)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const fm = readMemoryFrontmatter(text);
    const updated = Number(fm.updated ?? 0);
    const key = fm.name ?? "";
    if (!key || !Number.isFinite(updated) || updated <= 0) continue; // 解析不出就跳过，不猜
    entries.push({ key, updated, file });
  }

  const indexPath = join(dir, "MEMORY.md");
  const indexKeys: string[] = [];
  if (existsSync(indexPath)) {
    for (const line of readFileSync(indexPath, "utf8").split("\n")) {
      const m = line.match(INDEX_LINE_RE);
      if (m) indexKeys.push(m[1]);
    }
  }
  return { entries, indexKeys };
}

interface AnchorReport {
  /** 至少引用了 1 条仓内相对路径的条目数 */
  withPaths: number;
  /** 全部路径都不存在 —— 这类会被标 ⚠ */
  allDead: number;
  /** 部分不存在 —— 方案明确不标 */
  partialDead: number;
  /** 全部存在 */
  allAlive: number;
  /** allDead 的样例（最多 8 条，带 key 与失效路径），供人判断是不是「引用别的仓库」 */
  samples: { key: string; paths: string[] }[];
}

interface DirReport {
  dir: string;
  fileCount: number;
  indexCount: number;
  /** 索引行口径的年龄分档（真正会被注入的那些） */
  indexAges: AgeBucket[];
  /** 文件口径的年龄分档（不截断时的参考值） */
  fileAges: AgeBucket[];
  /** 锚点检测（没给 root 时为 undefined） */
  anchors?: AnchorReport;
}

/** 对单个记忆目录算 T2 + T3（root 为 undefined 时跳过 T3） */
function analyzeDir(dir: string, roots: string[] | undefined, now: number): DirReport {
  const { entries, indexKeys } = loadMemoryDir(dir);
  const byKey = new Map(entries.map((e) => [e.key, e]));

  // 索引行口径：只有能在磁盘上找到对应条目的才算（孤儿行不编造年龄，与 annotateIndexAges 同判据）
  const indexAges = indexKeys
    .map((k) => byKey.get(k))
    .filter((e): e is MemEntry => !!e)
    .map((e) => memoryAgeDays(e.updated, now));

  const report: DirReport = {
    dir,
    fileCount: entries.length,
    indexCount: indexKeys.length,
    indexAges: bucketizeAges(indexAges),
    fileAges: bucketizeAges(entries.map((e) => memoryAgeDays(e.updated, now))),
  };
  if (!roots?.length) return report;

  const anchors: AnchorReport = {
    withPaths: 0,
    allDead: 0,
    partialDead: 0,
    allAlive: 0,
    samples: [],
  };
  for (const entry of entries) {
    let body: string;
    try {
      body = stripFrontmatter(readFileSync(entry.file, "utf8"));
    } catch {
      continue;
    }
    const paths = extractRepoPaths(body);
    if (!paths.length) continue;
    anchors.withPaths++;
    // 多根判定：monorepo 的记忆常写成包内相对路径（iam-studio-fe 的 `src/api/x.ts`
    // 实际在 `anka-app/packages/*/src/api/x.ts`）。只按仓库根判会把这批全判成失效，
    // 实测误报率 37/38。任一根命中即算存在。
    const dead = paths.filter((p) => !roots.some((r) => existsSync(join(r, p))));
    if (!dead.length) anchors.allAlive++;
    else if (dead.length === paths.length) {
      anchors.allDead++;
      if (anchors.samples.length < 8) anchors.samples.push({ key: entry.key, paths: dead });
    } else anchors.partialDead++;
  }
  report.anchors = anchors;
  return report;
}

/** `0.987` → `98.7%`；分母为 0 时给 `—`，避免把「没有样本」读成「覆盖率 0」 */
function pct(bucket: AgeBucket): string {
  return bucket.total === 0 ? "—" : `${(bucket.ratio * 100).toFixed(1)}%`;
}

function renderDir(r: DirReport): string {
  const line = (label: string, buckets: AgeBucket[]) =>
    `  ${label}  ` +
    buckets.map((b) => `≥${b.threshold}天 ${pct(b)} (${b.aged}/${b.total})`).join("  ·  ");
  const out = [
    `\n### ${r.dir}`,
    `  文件 ${r.fileCount} 条 · 索引 ${r.indexCount} 行`,
    line("索引行口径", r.indexAges),
    line("文件口径  ", r.fileAges),
  ];
  if (r.anchors) {
    const a = r.anchors;
    out.push(
      `  锚点：引用路径 ${a.withPaths} 条 → 全部失效 ${a.allDead} · 部分失效 ${a.partialDead} · 全部存在 ${a.allAlive}`,
    );
    if (a.samples.length) {
      out.push("  全部失效样例（判断是否为「引用别的仓库」）：");
      for (const s of a.samples) out.push(`    · ${s.key}: ${s.paths.slice(0, 3).join(", ")}`);
    }
  }
  return out.join("\n");
}

/** 待分析的目录，以及该目录的锚点判据根（可多个：monorepo 的包根要一起给） */
interface Target {
  dir: string;
  roots?: string[];
}

function buildTargets(args: string[], home: string): { targets: Target[]; roots?: string[] } {
  // `--root` 与 `--extra-root` 都是候选判据根，区别只在第一个还负责派生项目记忆目录名
  const roots: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a !== "--root" && a !== "--extra-root") continue;
    const v = args[i + 1];
    if (v && !v.startsWith("--")) roots.push(resolve(v));
    i++; // 跳过取值，避免它被当成下一个 flag
  }
  const primary = roots[0];
  const targets: Target[] = [];

  if (args.includes("--all")) {
    // --all：全库扫年龄（项目目录名无法反解回真实路径），锚点只对主根派生的那一个目录跑
    try {
      for (const d of readdirSync(join(home, "projects"), { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const dir = join(home, "projects", d.name, "memory");
        if (!existsSync(dir)) continue;
        const isPrimary =
          !!primary && dir === join(home, "projects", projectKeyFor(primary), "memory");
        targets.push({ dir, roots: isPrimary ? roots : undefined });
      }
    } catch {
      /* 没有 projects 目录就只报全局 */
    }
  } else if (primary) {
    // 项目记忆目录名由 sanitizeProjectKey 派生，反解不可靠 —— 但正向派生是精确的
    targets.push({ dir: join(home, "projects", projectKeyFor(primary), "memory"), roots });
  } else {
    // 默认把 cwd 当仓库根：脚本通常在仓库里跑，不传参数也应该有完整报告
    const cwd = resolve(process.cwd());
    targets.push({ dir: join(home, "projects", projectKeyFor(cwd), "memory"), roots: [cwd] });
  }
  targets.push({ dir: join(home, "memory") }); // 全局记忆：没有单一仓库根，不做锚点

  // 同一个目录只留一份；带 roots 的那份优先（--all 与 --root 同时给时）
  const byDir = new Map<string, Target>();
  for (const t of targets) {
    const prev = byDir.get(t.dir);
    if (!prev || (!prev.roots && t.roots)) byDir.set(t.dir, t);
  }
  // 打印用的判据根：--all 且没给 --root 时没有单一根，其余情况是显式根或 cwd
  const effectiveRoots = roots.length
    ? roots
    : args.includes("--all")
      ? undefined
      : [resolve(process.cwd())];
  return { targets: [...byDir.values()], roots: effectiveRoots };
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const now = Date.now();
  const home = process.env.SID_CONFIG_DIR
    ? resolve(process.env.SID_CONFIG_DIR)
    : join(homedir(), ".sid-code");
  const { targets, roots } = buildTargets(args, home);

  const reports = targets
    .filter((t) => {
      try {
        return statSync(t.dir).isDirectory();
      } catch {
        return false;
      }
    })
    .map((t) => analyzeDir(t.dir, t.roots, now));

  if (json) {
    console.log(
      JSON.stringify({ generatedAt: new Date(now).toISOString(), roots, reports }, null, 2),
    );
    return;
  }

  console.log(`memory-drift-shadow-stats · ${new Date(now).toISOString().slice(0, 10)}`);
  console.log(`sid-code 配置根：${home}`);
  console.log(
    roots?.length
      ? `锚点判据根：${roots.join(" + ")}`
      : "锚点检测：未运行（加 --root <仓库路径> 开启）",
  );
  for (const r of reports) console.log(renderDir(r));
  if (!reports.length) console.log("\n（没有找到任何记忆目录）");
}

if (import.meta.main) main();
