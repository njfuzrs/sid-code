/**
 * Worktree 创建期告警（creation-time advisories）
 *
 * 定位：把「静默出错」变成「显式提示」，但不替用户做决定（对齐 CC「不猜、交给用户」哲学）。
 * 两类告警，均**只在条件真实成立时**触发，lockfile 一致 / 无 DB 时零输出（无噪音）。
 *
 * 1. 依赖一致性（比 CC 更进一步）
 *    - CC：默认不碰 node_modules，也不给任何依赖一致性提示。
 *    - sid-code：默认 symlink node_modules 到主仓（免装依赖、省磁盘），代价是
 *      当分支 lockfile 与主仓不同时，symlink 进来的是**主仓的依赖版本**而非本分支该有的版本，
 *      引发静默的 "module not found" / 版本错乱。这里做 lockfile hash 比对，
 *      不一致时告警——不自动跑 install（避免 install 的一堆边界 + 破坏现有行为），
 *      只把风险显式告诉用户，由用户决定是否手动重装。
 *
 * 2. 数据库 migration 提醒
 *    - 并行 worktree 共享同一数据库时 migration 可能互相打架（Cole Medin 称"静默杀手"）。
 *    - 检测到 migration 标记文件时追加一句提醒，纯字符串、零副作用。
 *
 * 设计约束：任何异常都吞掉（best-effort），绝不因告警逻辑阻断 worktree 创建。
 */

import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, dirname, join, normalize } from "path";

/** 主流 JS 包管理器的 lockfile（顺序即优先级） */
const LOCKFILES = [
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
] as const;

/** 读取 lockfile 内容 hash（不存在返回 null） */
function lockfileHash(dir: string, file: string): string | null {
  try {
    const p = join(dir, file);
    if (!existsSync(p)) return null;
    return createHash("sha256").update(readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

/** 一组 lockfile 比对结果：命中第一份两边都有的 lockfile 即定论（一致 null / 不一致文件名） */
function compareLockfilesIn(
  worktreeDir: string,
  mainDir: string,
): { decided: false } | { decided: true; mismatch: string | null } {
  for (const file of LOCKFILES) {
    const mainHash = lockfileHash(mainDir, file);
    const wtHash = lockfileHash(worktreeDir, file);
    // 只有两边都有同名 lockfile 才能比对；缺一（如 sparse-checkout 没检出）跳过该文件
    if (mainHash === null || wtHash === null) continue;
    return { decided: true, mismatch: mainHash !== wtHash ? file : null };
  }
  return { decided: false };
}

/** workspace 协议前缀（bun / pnpm / yarn 通用） */
const WORKSPACE_PROTOCOL = "workspace:";

/** 声明 workspace 依赖的四个字段（顺序即扫描顺序，只影响告警文案的顺序） */
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** 一个 workspace 内包的 package.json 摘要 */
interface WorkspacePkg {
  /** 包目录名（如 `tui`、`core`）—— 主仓 node_modules 里链接名通常就是它 */
  dirName: string;
  /** 该包声明的 workspace 依赖名（去重后） */
  deps: string[];
}

// 扫描 `<worktreePath>/packages/<pkg>/package.json`，收集 workspace 依赖声明。
// （注释里不写 `*` + `/` 相邻的形式，否则会提前闭合块注释。）
function collectWorkspaceDeps(worktreePath: string): WorkspacePkg[] {
  const out: WorkspacePkg[] = [];
  let entries: string[];
  try {
    entries = readdirSync(join(worktreePath, "packages"));
  } catch {
    return out; // 非 monorepo（无 packages/）→ 无 workspace 依赖可查
  }
  for (const entry of entries) {
    // 包目录下的 node_modules 也会被目录扫描命中；它不是包，跳过
    if (entry === "node_modules") continue;
    const pkgDir = join(worktreePath, "packages", entry);
    let raw: string;
    try {
      raw = readFileSync(join(pkgDir, "package.json"), "utf8");
    } catch {
      continue; // 目录但没有 package.json（如纯脚本目录）
    }
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      continue; // 坏 JSON 不阻断告警逻辑
    }
    if (!json || typeof json !== "object") continue;
    const deps: string[] = [];
    for (const field of DEP_FIELDS) {
      const bag = json[field];
      if (!bag || typeof bag !== "object") continue;
      for (const [name, version] of Object.entries(bag)) {
        if (typeof version !== "string" || !version.startsWith(WORKSPACE_PROTOCOL)) continue;
        if (!deps.includes(name)) deps.push(name);
      }
    }
    // 没有任何 workspace 依赖的包不必参与后续解析判定
    if (deps.length > 0) out.push({ dirName: entry, deps });
  }
  return out;
}

/** symlinkedDirs 里是否包含「worktree 根的 node_modules」（根链接才意味着用的是主仓那份依赖） */
function hasRootNodeModulesSymlink(symlinkedDirs: readonly string[]): boolean {
  return symlinkedDirs.some((dir) => normalize(dir).replace(/[\\/]+$/, "") === "node_modules");
}

/**
 * workspace 依赖可解析性检查（A2，2026-11-19 实测踩坑）。
 *
 * 为什么需要：`checkDependencyConsistency` 只比对 lockfile hash。主仓根
 * `node_modules/@sid-code/` 缺某个 workspace 包链接（如 `tui`）时，新建 worktree
 * symlink 进的是**同一个残缺目录**——lockfile 完全一致，一句告警都没有，
 * 直到 pre-commit 跑 `docs:gen-reference --check` 才炸 `Cannot find module '@sid-code/tui/...'`。
 * 实测 4 个并行 agent 里 3 个卡在 pre-commit 提交不了。
 *
 * 只在 symlinkedDirs 含根 `node_modules` 时才查：worktree 自己真实安装的 node_modules
 * 里软链是 worktree-local 的、可靠；而 symlink 自父仓的那份可能本身残缺，这才是 bug 场景。
 *
 * 解析顺序与 Node 一致：包内 `packages/<pkg>/node_modules/<dep>` → 根 `node_modules/<dep>`。
 * `existsSync` 会跟随 symlink，悬空链接返回 false —— 正是要判的情形，不要换成 `lstat`。
 *
 * @param worktreePath worktree 根
 * @param symlinkedDirs 本次确实建成 symlink 的目录（相对仓库根）
 * @param mainRoot 主仓根（用于给出「在主仓补建链接」的修复命令）
 * @returns 告警字符串（全部可解析 / 不适用时返回 null）
 */
export function checkWorkspaceDependencyResolvability(
  worktreePath: string,
  symlinkedDirs: readonly string[],
  mainRoot: string,
): string | null {
  try {
    if (!hasRootNodeModulesSymlink(symlinkedDirs)) return null;

    const pkgs = collectWorkspaceDeps(worktreePath);
    if (pkgs.length === 0) return null;

    const rootModules = join(worktreePath, "node_modules");
    // 整棵 node_modules 都不存在：这是「没装依赖」而不是「缺某几个包」。
    // 逐个报缺失会把真正原因埋掉，所以只出一条。
    if (!existsSync(rootModules)) {
      return (
        `worktree 未安装依赖：${rootModules} 不存在，workspace 包无法解析。\n` +
        `   建议：在 worktree 内安装依赖（cd ${worktreePath} && bun install）。`
      );
    }

    // 只记两层都缺的（ab 各自命中的在上面的 continue 里已放行）。
    // 额外记下「包内也没有」，因为修复位置不同：包内缺 → worktree 内重装；
    // 根缺 → 必须在主仓补建链接（worktree 内 bun install 会判 no changes 跳过）。
    const missing = new Set<string>();
    const missingInPkg = new Set<string>();

    for (const pkg of pkgs) {
      const pkgModules = join(worktreePath, "packages", pkg.dirName, "node_modules");
      for (const dep of pkg.deps) {
        if (existsSync(join(pkgModules, dep))) continue; // a. 包内解析路径
        missingInPkg.add(dep);
        if (existsSync(join(rootModules, dep))) continue; // b. 根 hoist 路径
        missing.add(dep); // c. 两层都缺 → 缺失
      }
    }

    if (missing.size === 0) return null;

    // 修复位置按「链接本该在哪」区分——这是本次踩坑的直接教训：
    // 只知道「缺 tui」就去 worktree 里 bun install 是无效的（bun 判 no changes 直接跳过）。
    const dirNameOf = (dep: string): string => {
      // 包目录名 = 链接名去掉 scope 前缀（@sid-code/tui → tui），与 bun workspace 链接命名一致
      const bare = dep.startsWith("@") ? (dep.split("/")[1] ?? dep) : dep;
      return bare;
    };

    const lines: string[] = [];
    lines.push(
      `workspace 依赖无法解析：${[...missing].join("、")} 在 worktree 的 node_modules ` +
        `（symlink 自主仓）里找不到，构建/检查会报 Cannot find module。`,
    );
    for (const dep of missing) {
      if (missingInPkg.has(dep)) {
        // 包内 node_modules 也没有 → 修复在 worktree 内重装（先装出包级链接，再修根）
        lines.push(
          `   包内 node_modules 缺 ${dep}：在 worktree 内重装依赖，cd ${worktreePath} && bun install`,
        );
      }
      // 根 node_modules 缺 → 修复在主仓：补建 workspace 链接
      lines.push(
        `   根 node_modules 缺 ${dep}：在主仓补建该链接，` +
          `ln -sfn ../../packages/${dirNameOf(dep)} ${join(mainRoot, "node_modules", dep)}`,
      );
    }
    lines.push(
      `   在 worktree 内 bun install 对根 node_modules 的缺失无效（bun 会判 no changes 直接跳过），` +
        `请先修主仓那份 node_modules。`,
    );
    return lines.join("\n");
  } catch {
    return null; // best-effort：告警逻辑绝不阻断 worktree 创建
  }
}

/**
 * 依赖一致性检查。
 *
 * 仅对「被 symlink 到主仓的 node_modules 目录」有意义——此时 worktree 用的是主仓依赖，
 * 若两边 lockfile 不同就会版本错乱。未 symlink 的目录各自独立，无此问题。
 *
 * 旧实现只认顶层的 `"node_modules"`：monorepo 用户在 symlinkDirectories 里配
 * `packages/app/node_modules` 时这条告警整个不生效。现在对每个 basename 为 `node_modules`
 * 的链接目录，从它的父目录（包级 lockfile）逐级向上找到仓库根（workspace 根 lockfile），
 * 取第一层两边都有 lockfile 的目录比对 —— 与包管理器自己找 lockfile 的方向一致。
 *
 * @param worktreePath worktree 根
 * @param gitRoot 主仓根
 * @param symlinkedDirs 本次确实建成 symlink 的目录（相对仓库根，来自 symlinkDirectories）
 * @returns 告警字符串（无风险返回 null）
 */
export function checkDependencyConsistency(
  worktreePath: string,
  gitRoot: string,
  symlinkedDirs: readonly string[],
): string | null {
  const warnings: string[] = [];

  // A2：workspace 依赖可解析性。放在 lockfile 早退**之前**——主仓 node_modules 残缺时
  // lockfile 通常完全一致（同一份 lock 装出来的），旧逻辑一句都不报，正是要修的漏报。
  const resolvability = checkWorkspaceDependencyResolvability(worktreePath, symlinkedDirs, gitRoot);
  if (resolvability) warnings.push(resolvability);

  const mismatches: string[] = [];
  const seen = new Set<string>();
  for (const dir of symlinkedDirs) {
    const rel = normalize(dir).replace(/[\\/]+$/, "");
    if (basename(rel) !== "node_modules") continue;
    // 从链接所在包目录逐级向上（含仓库根），第一层可比对的 lockfile 即定论
    let pkg = dirname(rel);
    for (;;) {
      if (!seen.has(pkg)) {
        seen.add(pkg);
        const r = compareLockfilesIn(join(worktreePath, pkg), join(gitRoot, pkg));
        if (r.decided) {
          if (r.mismatch) mismatches.push(pkg === "." ? r.mismatch : join(pkg, r.mismatch));
          break;
        }
      } else break; // 这一层（及其上层）已被别的链接目录判过
      if (pkg === "." || pkg === "") break;
      pkg = dirname(pkg);
    }
  }
  if (mismatches.length > 0) {
    warnings.push(
      `依赖不一致：${mismatches.join("、")} 与主仓不同，但对应的 node_modules 是 symlink 到主仓的。\n` +
        `   worktree 里跑的将是**主仓的依赖版本**，可能导致 module not found / 版本错乱。\n` +
        `   建议：在此 worktree 内重装依赖（如 pnpm/bun/npm install），或删除 node_modules 软链后独立安装。`,
    );
  }

  if (warnings.length === 0) return null;
  // 多条告警用空行分段，便于日志/终端里区分两件不同的事
  return warnings.join("\n\n");
}

/**
 * 检测项目是否使用数据库 migration。
 * 命中即返回标记路径，用于向用户提示并行 worktree 的 DB 冲突风险。
 */
const DB_MIGRATION_MARKERS = [
  "prisma/schema.prisma",
  "prisma/migrations",
  "drizzle.config.ts",
  "drizzle.config.js",
  "knexfile.js",
  "knexfile.ts",
  "alembic.ini",
  "migrations", // Django / 通用 migrations 目录（放最后，避免误命中更精确的路径）
] as const;

/**
 * 数据库 migration 提醒。
 * @returns 告警字符串（未检测到 DB 返回 null）
 */
export function checkDatabaseUsage(worktreePath: string): string | null {
  let hit: string | null = null;
  for (const marker of DB_MIGRATION_MARKERS) {
    try {
      if (existsSync(join(worktreePath, marker))) {
        hit = marker;
        break;
      }
    } catch {
      /* 忽略单个 marker 的 stat 异常 */
    }
  }
  if (!hit) return null;
  return (
    `检测到数据库 migration（${hit}）。\n` +
    `   并行 worktree 共享同一数据库时，migration 可能互相冲突（table already exists / schema 覆盖）。\n` +
    `   建议：为本 worktree 指向独立 DB（改 DATABASE_URL），或用 Neon/PlanetScale 等 DB 分支。`
  );
}
