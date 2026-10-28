/**
 * 文件编辑意图声明（并发冲突检测 Phase 1）
 *
 * 每个会话在开始编辑文件时，向共享存储声明意图。
 * 其他会话在 Edit/Write 前检查是否有冲突。
 *
 * 存储结构：~/.sid-code/file-intents/<sessionId>.json
 * 每个会话一个文件，包含该会话正在关注的所有文件列表。
 *
 * 设计决策：
 * - 按 sessionId 一文件（不是按被编辑文件一文件）——避免锁文件爆炸
 * - intent 不是 lock——不阻塞其他会话，只用于检测和告警
 * - 自动过期——lastAccessAt 超过 5 分钟未更新的 intent 视为过期（防止崩溃残留）
 */

import {
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
  existsSync,
  realpathSync,
  renameSync,
} from "fs";
import { join, dirname, resolve, basename, relative } from "path";
import { sidPaths } from "../config/paths.ts";
import { isProcessAlive } from "./concurrent.ts";
import { getLogger } from "../debug/logger.ts";
import { findCanonicalGitRoot } from "../worktree/canonical.ts";

/** 文件操作类型 */
export type FileOperation = "read" | "edit" | "write";

/** 单个文件的编辑意图 */
export interface FileIntent {
  /** 逻辑键：折回主仓后的绝对路径（NFC + realpath 归一化，意图表的索引） */
  path: string;
  /**
   * PR-1（双轨）：声明方所在的**物理路径**（realpath 归一化，不折叠）。
   * 与 path 的区别：worktree 里声明的文件 path 折回主仓，physicalPath 保留
   * worktree 内的真实位置——冲突分类靠它区分「同一份文件」（互覆盖，须拦）
   * 与「同逻辑文件的分支分叉」（合并时才撞车，PR-4 据此不弹窗）。
   * 旧记录（PR-1 之前写入）没有此字段，读取方按 `?? path` 回退。
   */
  physicalPath?: string;
  /** 声明时间戳 */
  declaredAt: number;
  /** 最近一次 Read/Edit/Write 时间 */
  lastAccessAt: number;
  /** 最近一次操作类型（B5：只升不降，read 冲不掉 edit/write） */
  operation: FileOperation;
}

/** 会话的文件意图集合 */
export interface SessionFileIntents {
  sessionId: string;
  pid: number;
  cwd: string;
  files: Record<string, FileIntent>;
}

/** 过期时间：5 分钟（毫秒） */
const INTENT_EXPIRY_MS = 5 * 60 * 1000;

function intentsDir(): string {
  return sidPaths.fileIntents();
}

function intentPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(intentsDir(), `${safe}.json`);
}

/**
 * PR-1（B1/B2/B-a/B-b）：路径 → { 逻辑键, 物理路径 } 双轨解析。
 *
 * ## 为什么弃用纯正则剥前缀（W15 旧实现）
 *
 * 旧实现 `replace(/\/\.(?:sid-code|claude)\/worktrees\/(?!\.)[^/]+(?=\/)/g, "")` 有两个
 * 结构性盲区，都实测过：
 * - **B2 漏检**：`git worktree add ../feat-x` 这类**仓库外同级 worktree** 路径里没有
 *   容器段，正则完全不识别 → 与主仓同一逻辑文件的冲突零命中。
 * - **误折叠**：容器目录下**不是** worktree 的普通子目录（如临时产物）也会被剥掉一级，
 *   映射到一个主仓里不存在的位置。
 *
 * ## 新算法（以 git 自己的记录为准，不猜路径形态）
 *
 * 1. **物理路径** = realpath 归一化。目标可能不存在（write 新建，B-a）：
 *    realpathSync 会抛 ENOENT，改用「最近已存在祖先」策略——逐级向上找第一个
 *    能 realpath 的祖先，再把剩余段拼回去。
 * 2. **逻辑键** = 从 `dirname(物理路径)` 向上找最近的 `.git`（B-b：必须以文件位置起算，
 *    不能用进程 cwd——工具可以对任意绝对路径操作）：
 *    - `.git` 是目录 → 该目录就是主仓根，本地根 = 主仓根。
 *    - `.git` 是 pointer 文件 → 这是 linked worktree，用 findCanonicalGitRoot 读
 *      commondir 回溯主仓根（纯 statSync/readFileSync，无子进程）。
 *    - 逻辑键 = join(主仓根, relative(本地根, 物理路径))——不管 worktree 摆在仓库内
 *      容器下还是仓库外同级目录，同一逻辑文件折到同一个键（修 B2）。
 *    - **null 回退必须双侧对称**：推不出主仓根（separate-git-dir 布局 / 非 git 目录）
 *      时回退为物理路径本身。写入侧与查询侧走的是**这同一个函数**，回退天然对称，
 *      不会出现"写进去的键和查询算出的键对不上"的静默漏检。
 *
 * ## A2：性能是必需项
 *
 * declareFileIntent 是全仓最高频路径之一（read.ts 每次读文件都调）。上面的解析含
 * 多次同步 stat + 文件读取，必须缓存：dir → 主仓根 记忆化 + filePath → 解析结果
 * 记忆化（有界 Map，满即整体清空——键空间是"本会话摸过的文件数"，正常几百，
 * 清空重算的代价远低于无界增长的内存）。
 */

/** dir → { 本地 checkout 根, 主仓根 }（null = 非 git / 推不出）记忆化。有界防泄漏。 */
const canonicalRootCache = new Map<string, { localRoot: string; mainRoot: string } | null>();
/** filePath → 解析结果记忆化。有界防泄漏。 */
const resolveCache = new Map<string, { key: string; physical: string }>();
const CACHE_MAX = 2048;

/** 测试专用：清空两级缓存（worktree 建/删会让缓存失效）。 */
export function __clearIntentKeyCache(): void {
  canonicalRootCache.clear();
  resolveCache.clear();
}

/**
 * B-a：realpath 归一化，容忍路径不存在（write 新建文件）。
 * 从目标逐级向上找第一个存在的祖先做 realpath，再把剩余段拼回。
 * 全程失败（极端：连 / 都不可 stat）则原样返回绝对路径。
 */
function physicalPathOf(filePath: string): string {
  const abs = resolve(filePath);
  const missing: string[] = [];
  let cur = abs;
  for (let depth = 0; depth < 256; depth++) {
    if (existsSync(cur)) {
      let real: string;
      try {
        real = realpathSync(cur);
      } catch {
        return abs;
      }
      return missing.length ? join(real, ...missing.reverse()) : real;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    missing.push(basename(cur));
    cur = parent;
  }
  return abs;
}

/**
 * 从 fromDir 向上找最近的 `.git`（目录或 pointer 文件）。
 * 返回本地 checkout 根与主仓根；非 git 环境返回 null。
 */
function canonicalRootFrom(fromDir: string): { localRoot: string; mainRoot: string } | null {
  // 缓存必须存整个 { localRoot, mainRoot }：localRoot 是向上走出来的 checkout 根，
  // **不是** fromDir 本身——只缓存 mainRoot 会让 relative(localRoot, …) 拿错基准，
  // 把 `<repo>/src/a.ts` 折成 `<repo>/src/src/a.ts` 这类叠路径。
  const cached = canonicalRootCache.get(fromDir);
  if (cached !== undefined) return cached;
  const result = computeCanonicalRoot(fromDir);
  if (canonicalRootCache.size >= CACHE_MAX) canonicalRootCache.clear();
  canonicalRootCache.set(fromDir, result);
  return result;
}

function computeCanonicalRoot(fromDir: string): { localRoot: string; mainRoot: string } | null {
  let dir = resolve(fromDir);
  for (let depth = 0; depth < 256; depth++) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      // dir 就是本地 checkout 根（主仓或 linked worktree）。
      // findCanonicalGitRoot 从 dir 起算会把 pointer 折回主仓根；主仓内则原样返回 dir。
      const mainRoot = findCanonicalGitRoot(dir);
      // B-b 对称回退：推不出主仓根（separate-git-dir 等）→ 整个解析放弃，
      // 上层回退物理路径。这里绝不"向上再找找"——会撞到外层无关仓库。
      return mainRoot ? { localRoot: dir, mainRoot } : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * 双轨解析入口：逻辑键（意图表索引）+ 物理路径（冲突分类）。
 * 导出供 conflict-detector 复用——查询侧与写入侧必须走同一函数（B-b 对称性）。
 */
export function resolveIntentKey(filePath: string): { key: string; physical: string } {
  const nfc = filePath.normalize("NFC");
  const hit = resolveCache.get(nfc);
  if (hit) return hit;

  const physical = physicalPathOf(nfc);
  const roots = canonicalRootFrom(dirname(physical));
  let key: string;
  if (roots) {
    const rel = relative(roots.localRoot, physical);
    // rel 以 .. 开头 = 物理路径不在本地根之下（符号链接把文件指到了仓库外等），
    // 折叠没有意义，回退物理路径。
    key = rel && !rel.startsWith("..") ? join(roots.mainRoot, rel) : physical;
  } else {
    key = physical;
  }

  const result = { key, physical };
  if (resolveCache.size >= CACHE_MAX) resolveCache.clear();
  resolveCache.set(nfc, result);
  return result;
}

/**
 * 意图表的键（逻辑路径）。签名保持单参——既有调用点（含 W15 回归测试）不改。
 * 语义变化见 resolveIntentKey 头注释：正则剥前缀 → git 记录回溯。
 */
export function intentKeyForPath(filePath: string): string {
  return resolveIntentKey(filePath).key;
}

/**
 * 声明文件编辑意图。
 *
 * @param sessionId 当前会话 ID
 * @param pid 当前进程 PID
 * @param cwd 当前工作目录
 * @param filePath 文件绝对路径（会被 NFC 归一化）
 * @param operation 操作类型
 */
export function declareFileIntent(
  sessionId: string,
  pid: number,
  cwd: string,
  filePath: string,
  operation: FileOperation,
): void {
  try {
    mkdirSync(intentsDir(), { recursive: true });

    const { key, physical } = resolveIntentKey(filePath);
    const now = Date.now();
    const path = intentPath(sessionId);

    let intents: SessionFileIntents = {
      sessionId,
      pid,
      cwd,
      files: {},
    };

    // 读取现有 intents
    if (existsSync(path)) {
      try {
        intents = JSON.parse(readFileSync(path, "utf-8"));
      } catch {
        // 损坏的文件，覆盖
      }
    }

    // B5：operation 只升不降。旧实现无条件覆盖——同一会话 edit 之后任何一次 read
    // 都会把意图冲成 read，而 checkConflict 默认 blockingOperations=["edit","write"]
    // 会把 read 过滤掉，于是"我刚刚编辑过这个文件"的声明被自己后续的读**静默撤销**，
    // 其它会话的冲突检测随之失明。强度序：read < edit/write（edit 与 write 同级，
    // 互相覆盖无损失——两者都是"改动"语义）。
    const strength = (op: FileOperation): number => (op === "read" ? 0 : 1);
    const existing = intents.files[key];
    const merged: FileOperation =
      existing && strength(existing.operation) > strength(operation)
        ? existing.operation
        : operation;

    intents.files[key] = {
      path: key,
      // 双轨：物理路径单独存，冲突分类（同一份文件 vs 分支分叉）靠它
      physicalPath: physical,
      declaredAt: existing?.declaredAt ?? now,
      lastAccessAt: now,
      operation: merged,
    };

    // C1：temp + rename 原子写。旧实现直接 writeFileSync 目标文件——读侧
    // queryAllFileIntents 对 parse 失败的文件直接 unlinkSync，半写文件会被
    // 并发读者当成"损坏"误删（那不是防御，是数据丢失路径）。rename 同目录内
    // 原子，读侧要么看到完整旧文件要么完整新文件。临时名不以 .json 结尾，
    // 不会被读侧的 readdir 过滤器扫到。
    const tmpPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(intents, null, 2));
    renameSync(tmpPath, path);
  } catch (err: any) {
    // 声明失败不应阻塞操作，但需可观测
    getLogger().warn("FILE-INTENT", `声明文件意图失败: ${err?.message ?? err}`);
  }
}

/**
 * 清理会话的所有文件意图。
 * 在会话退出时调用。
 */
export function clearFileIntent(sessionId: string): void {
  try {
    const path = intentPath(sessionId);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch (err: any) {
    getLogger().warn("FILE-INTENT", `清理文件意图失败: ${err?.message ?? err}`);
  }
}

/**
 * 查询所有活跃会话的文件意图。
 *
 * @returns 按 sessionId 索引的意图集合（已过滤 stale 和过期）
 */
export function queryAllFileIntents(): Record<string, SessionFileIntents> {
  const dir = intentsDir();
  if (!existsSync(dir)) return {};

  const result: Record<string, SessionFileIntents> = {};
  const now = Date.now();

  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return {};
  }

  for (const file of files) {
    const full = join(dir, file);
    let intents: SessionFileIntents;
    try {
      intents = JSON.parse(readFileSync(full, "utf-8"));
    } catch {
      // 损坏的文件，清理
      try {
        unlinkSync(full);
      } catch {
        /* 忽略 */
      }
      continue;
    }

    // 检查进程是否存活
    if (!isProcessAlive(intents.pid)) {
      try {
        unlinkSync(full);
      } catch {
        /* 忽略 */
      }
      continue;
    }

    // 过滤过期的文件意图
    const activeFiles: Record<string, FileIntent> = {};
    for (const [path, intent] of Object.entries(intents.files)) {
      if (now - intent.lastAccessAt < INTENT_EXPIRY_MS) {
        activeFiles[path] = intent;
      }
    }

    if (Object.keys(activeFiles).length > 0) {
      result[intents.sessionId] = {
        ...intents,
        files: activeFiles,
      };
    }
  }

  return result;
}

/**
 * 查询特定文件的编辑意图。
 *
 * @param targetFile 目标文件绝对路径（会被 NFC 归一化）
 * @param excludeSessionId 排除的会话 ID（通常是当前会话自己）
 * @returns 声明了该文件的其他会话列表
 */
export function queryFileIntents(
  targetFile: string,
  excludeSessionId?: string,
): Array<{
  sessionId: string;
  pid: number;
  cwd: string;
  intent: FileIntent;
}> {
  // B-b 对称性：查询侧与 declareFileIntent 走**同一个** resolveIntentKey——
  // 包括"推不出主仓根时回退物理路径"这条降级路径，两侧永远同口径。
  const normalizedPath = intentKeyForPath(targetFile);
  const allIntents = queryAllFileIntents();
  const conflicts: Array<{
    sessionId: string;
    pid: number;
    cwd: string;
    intent: FileIntent;
  }> = [];

  for (const [sessionId, sessionIntents] of Object.entries(allIntents)) {
    if (excludeSessionId && sessionId === excludeSessionId) {
      continue;
    }

    const intent = sessionIntents.files[normalizedPath];
    if (intent) {
      conflicts.push({
        sessionId,
        pid: sessionIntents.pid,
        cwd: sessionIntents.cwd,
        intent,
      });
    }
  }

  return conflicts;
}
