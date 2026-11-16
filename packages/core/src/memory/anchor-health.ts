/**
 * 记忆锚点健康度（漂移与维护方案 T3，2026-11-15）。
 *
 * ## 它回答什么
 *
 * 记忆正文里引用的仓内相对路径（「锚点」），有多少条记忆引用的路径**全部不存在**
 * ——这类记忆的正文已经与代码脱节，模型照着它去 Read 会读不到东西。
 *
 * ## 为什么只做统计，不往索引行打 ⚠
 *
 * 影子统计（2026-11-07）实测误报面：sid-code 库「全部失效」14/117、
 * 「部分失效」44/117，而 `iam-studio-fe` 单根判定下 **97% 被判失效** ——
 * 因为那条记忆整篇在讲别的仓库。把 ⚠ 打进索引等于把 71%–97% 的噪声
 * 常驻进每个会话的 system prompt，代价远大于收益（北极星「更安全 ↔ 更省」）。
 *
 * 所以这里只产出两个数，交给 `memory_index_health` 埋点：分布是否真的在恶化，
 * 先让数据说话。判定口径本身也刻意保守：**只认「全部不存在」**，
 * 「部分不存在」不计数（可能是新目录 / 子包相对路径）。
 *
 * 口径与影子统计脚本 `scripts/memory-drift-shadow-stats.ts` **同源**：
 * 提取函数从脚本搬到这里，脚本改为从这里 import，避免两份正则各改一半。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

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

export interface AnchorHealth {
  /** 正文里至少引用了一个仓内相对路径的记忆条数（分母） */
  referencedEntries: number;
  /** 引用了路径、且这些路径在**所有给定根下都不存在**的记忆条数（分子） */
  deadEntries: number;
}

/**
 * 统计锚点健康度。
 *
 * @param bodies  记忆正文（已剥 frontmatter 的 `value`）
 * @param roots   候选仓库根。多根是必需而非可选：monorepo 的记忆常写成包内相对路径
 *                （`src/api/x.ts`），实际位于 `pkg-a/src/api/x.ts`；只给仓库根会把
 *                这类全判成失效（iam-studio-fe 实测 37/38）。
 *                **空数组 = 没有可信的根 → 返回 0/0**（宁可不报，也不拿错根判一堆假失效）。
 * @param exists  验存在性的注入点（默认 `fs.existsSync`），单测用它造假数据，
 *                不依赖真实文件系统布局。
 */
export function countAnchorHealth(
  bodies: Iterable<string>,
  roots: readonly string[],
  exists: (absPath: string) => boolean = existsSync,
): AnchorHealth {
  const health: AnchorHealth = { referencedEntries: 0, deadEntries: 0 };
  if (roots.length === 0) return health;
  for (const body of bodies) {
    const paths = extractRepoPaths(body);
    if (paths.length === 0) continue;
    health.referencedEntries++;
    // 任一根命中即算活着：monorepo 的包内相对路径只在子包根下成立。
    const anyAlive = paths.some((p) => roots.some((root) => exists(join(root, p))));
    if (!anyAlive) health.deadEntries++;
  }
  return health;
}
