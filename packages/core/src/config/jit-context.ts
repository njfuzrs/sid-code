/**
 * JIT (Just-In-Time) 上下文管理器
 * 当工具访问文件时，自动发现并加载该路径上的 CLAUDE.md 上下文
 *
 * ## 设计不变量（改动前必读）
 *
 * 1. **路径口径统一**：所有进出本模块的路径都先过 `normalizeToolPath`（绝对化 + NFC），
 *    再过 `safeResolvePath`（realpath 解引用）。去重键用 realpath 原样，**不做
 *    `toLowerCase()`** —— 大小写敏感 FS 上 `src/Ui` 与 `src/ui` 是两个目录，
 *    小写化会把两份规则撞成一份（P1-4 / P2-5）。
 * 2. **边界判定双重叠加**：路径段比对（`dir === root || dir.startsWith(root + sep)`）
 *    **加上** realpath 解引用。只做前者会被 symlink 绕过（P0-2），只做后者会被
 *    `proj-evil` 这类字符串前缀兄弟目录绕过（P0-1）。两者缺一不可。
 * 3. **注入内容绝不截断**：超限只经 `noteMemoryFileSize` 登记 + 告警（P2-2）。
 * 4. **候选文件名单一事实源**：从 `rules.ts` import，不在本文件自建副本（P1-1）。
 */

import { dirname, join, relative, sep } from "path";
import { existsSync, statSync } from "fs";
import { getLogger } from "../debug/logger.ts";
import { normalizeToolPath } from "../tool/path-utils.ts";
// P2-3：顶层静态 import 替代函数内 await import()，消除首次 JIT 的模块加载抖动
// （动态 import 串在工具结果返回给模型之前，直接进 TTFT）。
import {
  CLAUDE_MD_FILES,
  CLAUDE_LOCAL_FILES,
  CLAUDE_RULES_DIR,
  parseRulesFrontmatter,
  rulesPathsMatch,
  safeResolvePath,
  noteMemoryFileSize,
  recordSkippedExternalImport,
  MAX_MEMORY_CHARACTER_COUNT,
} from "./rules.ts";
import { processImports } from "./import-processor.ts";
import { getClaudeMdExternalImportsApproved } from "./app-config.ts";

/**
 * JIT 候选文件名（与主加载路径同一事实源 + 本地私有规则）。
 *
 * 顺序即优先级：先无条件的通用候选，再本地私有（`CLAUDE.local.md`，主加载路径的
 * Local 层，JIT 侧此前完全盲区）。`.claude/rules/` 目录不在此列 —— 它是目录不是文件，
 * 由 `scanRulesDir` 单独递归（带 realpath 去重防 symlink 环）。
 */
const JIT_CANDIDATE_FILES: readonly string[] = [...CLAUDE_MD_FILES, ...CLAUDE_LOCAL_FILES];

/**
 * JIT 上下文发现的默认值 —— **唯一事实源**。
 *
 * 为什么需要它：`jitContext?: boolean` 的 optional 语义下，「未设置=开启」这个事实
 * 无法由类型系统承载。靠各消费点各写 `=== false` 维持它是**调用约定**，而新增消费点
 * 写成 `if (config.jitContext)` 会静默把默认值反转成 false —— 且只在「用户没配」
 * 这条最常见的路径上反转：配了 `true` 的用户测不出来，没配的用户静默失去整套机制。
 *
 * 配套门禁：`tests/config/jit-context-default-single-source.test.ts` 静态扫描 `src/`，
 * 裸比较会在 CI 上变红。**靠纪律维持的约定必然漏网。**
 *
 * 另：**不要**给 `settings/types.ts` 的 Zod schema 加 `.default(true)` —— settings.json
 * 的 round-trip 是有损的，给 optional 字段加默认值会让「用户没写这个字段」和
 * 「用户写了 true」在写回时无法区分，把一个读取侧问题换成一个写入侧问题。
 */
export const JIT_CONTEXT_DEFAULT = true;

/**
 * 判定 JIT 上下文发现是否启用。**所有消费点必须走这里**，不要自己写 `=== false`。
 *
 * 入参刻意收窄成结构类型而非完整 `Config`，这样测试与子模块（如 `ProviderRegistry`）
 * 都能直接传，不必构造整份配置。
 */
export function isJitContextEnabled(config: { jitContext?: boolean }): boolean {
  return config.jitContext ?? JIT_CONTEXT_DEFAULT;
}

/** 一次 JIT 发现的结构化结果（供埋点与记账使用） */
export interface JitDiscovery {
  /** 注入文本（已格式化，含静默条款）。无新发现时为 null */
  text: string | null;
  /** 本次新加载的文件明细 */
  loaded: Array<{
    /** 绝对路径（realpath 后） */
    path: string;
    /** 相对项目根的路径（埋点用，避免泄露绝对路径） */
    relPath: string;
    /** 注入正文字节数（格式化后的整块，含包装） */
    bytes: number;
    /**
     * 加载归因（对齐 CC 的 `load_reason`）：
     * - `nested_traversal`：向上遍历目录链发现的无条件规则
     * - `path_glob_match`：带 frontmatter `paths:` 且命中当前活动文件
     * - `local`：`CLAUDE.local.md` 本地私有规则
     * - `rules_dir`：`.claude/rules/*.md`
     */
    reason: "nested_traversal" | "path_glob_match" | "local" | "rules_dir";
    /** 是否超过 MAX_MEMORY_CHARACTER_COUNT（仅告警，内容未截断） */
    oversized: boolean;
  }>;
  /** 本次因作用域未命中而跳过的文件数（埋点用：JIT「浪费率」的分子之一） */
  scopeSkipped: number;
  /**
   * 读取失败明细（P2-8：不再静默）。`ENOENT` 不进此列（候选文件不存在属正常）。
   */
  failures: Array<{
    path: string;
    code: string;
    phase: "probe" | "read" | "import";
    message: string;
  }>;
  /** 本次发现耗时（毫秒，埋点用：JIT 是否进 TTFT 的实测依据） */
  elapsedMs: number;
}

/** 已加载条目的快照（P1-2 新鲜度校验用） */
interface LoadedEntry {
  /** 格式化后的注入正文 */
  formatted: string;
  /**
   * 本条规则「归属」的目录 —— 即向上遍历时命中它的那一级祖先目录（realpath）。
   *
   * 注意不等于 `dirname(路径)`：`.claude/rules/x.md` 与 `.claude/CLAUDE.md` 的
   * `dirname` 是 `.claude/rules` / `.claude`，而它们归属的是**外层那一级目录**。
   * `hasStaleOnChain` 靠这个字段判断「这条规则会不会出现在本次访问的目录链上」，
   * 用 dirname 会让这两类嵌套形态永远判不上链。
   */
  ownerDir: string;
  /** 读盘时的 mtimeMs（0 表示未知，此时不做新鲜度判定） */
  mtimeMs: number;
  /** 读盘时的字节数（mtime 精度不足时的第二判据） */
  size: number;
  /** 相对项目根路径（埋点/日志用） */
  relPath: string;
}

/** 空发现结果（各处提前返回时共用，避免手写多份字面量漂移） */
function emptyDiscovery(elapsedMs = 0): JitDiscovery {
  return { text: null, loaded: [], scopeSkipped: 0, failures: [], elapsedMs };
}

/**
 * 从规则文件路径反推它「归属」的目录 —— 即向上遍历时会命中它的那一级祖先。
 *
 * 用于 `markLoaded` 这类只拿到文件路径、拿不到遍历上下文的入口（正常发现路径由
 * 调用链直接传 `ownerDir`，不走这里）。三种形态：
 *   - `<dir>/CLAUDE.md`            → `<dir>`
 *   - `<dir>/.claude/CLAUDE.md`    → `<dir>`（上两级）
 *   - `<dir>/.claude/rules/x.md`   → `<dir>`（上三级，含子目录时继续上溯）
 *
 * 判据是路径中是否含 `.claude` 段，而不是数固定层数 —— `.claude/rules/a/b.md`
 * 这种嵌套子目录形态数层数会算错。
 */
function ownerDirOf(absFilePath: string): string {
  let dir = dirname(absFilePath);
  // 从 `.claude` 段（含其下任意深度）一路退回到它的父目录
  const segs = dir.split(sep);
  const idx = segs.lastIndexOf(".claude");
  if (idx > 0) dir = segs.slice(0, idx).join(sep) || sep;
  return safeResolvePath(dir);
}

/** 取文件 mtimeMs + size；失败返回 0（不做新鲜度判定，退化为「永不失效」） */
function fileStamp(path: string): { mtimeMs: number; size: number } {
  try {
    const st = statSync(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

/**
 * JIT 上下文管理器
 *
 * 当工具（read/write/edit/grep/glob/read_many/notebook_edit/ls/lsp 等文件类工具）
 * 访问文件时，检查该文件所在目录及其祖先目录是否有未加载的 CLAUDE.md。
 * 如果有，加载并追加到系统提示词中。
 *
 * 缓存已扫描的目录路径，避免重复扫描。
 */
export class JitContextManager {
  /**
   * 已加载的规则文件 → 快照（realpath 原样为键，**不小写化**）。
   * 从 `Set<path>` 升级为 `Map` 是 P1-2 的需要：命中已加载项时比对 mtime，
   * 变了就重新读盘，会话中途改规则也能生效。
   */
  private loaded = new Map<string, LoadedEntry>();
  /** 已扫描的目录路径集合（realpath 原样） */
  private scannedDirs = new Set<string>();

  /**
   * 根据工具访问的路径，发现新的上下文。
   *
   * @param accessedPath 工具访问的路径（可为相对路径 / `~` 形态，内部统一归一化）
   * @param projectRoot 项目根（内部同样归一化 + realpath，与 accessedPath 同口径）
   * @returns 结构化发现结果；无新发现时 `text` 为 null
   */
  async discoverDetailed(accessedPath: string, projectRoot: string): Promise<JitDiscovery> {
    const log = getLogger();
    const startedAt = performance.now();

    // 评测隔离：SID_CODE_DISABLE_PROJECT_RULES=1 时禁用 JIT CLAUDE.md 发现
    // 否则 agent grep src/ 时仍可能触发同目录 CLAUDE.md 加载，泄露 case 锚点
    if (process.env.SID_CODE_DISABLE_PROJECT_RULES === "1") {
      return emptyDiscovery();
    }

    // ── 路径口径统一（P1-4）──
    // 工具 schema 明确允许相对路径（grep/glob 的 path），而各工具内部都过
    // normalizeToolPath，只有 JIT 这条旁路没过 → 相对路径时 dirname 得到相对段，
    // 与绝对 projectRoot 比对必然失败，while 循环一次都不进，**静默返回 null**。
    // 这里补齐归一化；normalizeToolPath 会对 null byte 抛错，捕获后跳过该路径。
    let absAccessed: string;
    let absRoot: string;
    try {
      // projectRoot 先按 getCwd() 归一化（它自己也可能是相对路径 / `~` 形态），
      // 再用归一化后的项目根作为 accessedPath 的基准 —— 而**不是** getCwd()。
      //
      // 为什么不用 getCwd()：工具侧的相对路径确实相对 cwd，但 JIT 的语义是
      // 「这个路径在项目里的哪个位置」。两者在 cwd == projectRoot 时等价，
      // 在子代理 worktree（`withAgentCwd` 让 getCwd() 指向 worktree）、
      // bash `cd` 改过全局 cwd、或调用方显式传入其它 projectRoot 时会分叉。
      // 以 projectRoot 为基准可保证边界判定与解析基准同源，不会出现
      // 「按 cwd 解析出项目外路径 → 边界判定拒绝 → 静默返回 null」这种自相矛盾。
      absRoot = normalizeToolPath(projectRoot);
      absAccessed = normalizeToolPath(accessedPath, absRoot);
    } catch (err: any) {
      log.debug("JIT", `路径归一化失败，跳过: ${accessedPath} (${err?.message})`);
      return emptyDiscovery(performance.now() - startedAt);
    }

    // ── 边界基准也要 realpath（P0-2）──
    // 项目根本身可能是 symlink（`/tmp/link → /real/proj`），只解引用被访问侧
    // 会导致「真身路径 vs 链接路径」比对失败、规则一份都加载不到。两侧同口径。
    const realRoot = safeResolvePath(absRoot);

    // 获取文件所在目录
    let targetDir: string;
    /** 访问目标本身是否是目录（决定下面 realAccessed 要不要再拼回 basename） */
    let targetIsDir = false;
    const failures: JitDiscovery["failures"] = [];
    try {
      const st = statSync(absAccessed);
      targetIsDir = st.isDirectory();
      targetDir = targetIsDir ? absAccessed : dirname(absAccessed);
    } catch (err: any) {
      // 文件不存在（write 新建文件的常见形态）或无法访问 → 按目录名处理。
      // ENOENT 是正常路径，不记 failure；其余（EACCES 等）记录供上层可见化（P2-8）。
      if (err?.code && err.code !== "ENOENT") {
        failures.push({
          path: absAccessed,
          code: String(err.code),
          phase: "probe",
          message: String(err?.message ?? err),
        });
      }
      targetDir = dirname(absAccessed);
    }

    // ── 目录去重键：realpath 原样，不 toLowerCase（P2-5）──
    // 小写化在大小写敏感 FS（Linux ext4 / macOS APFS 区分大小写卷）上会把
    // `src/Ui` 与 `src/ui` 判成同一目录 → 后者的规则永远拿不到。
    // realpath 已把 symlink 与真身归一，这是比小写化更正确的归一维度。
    const realTargetDir = safeResolvePath(targetDir);

    // 活动文件也必须落在 realpath 命名空间里，才能与 realRoot 相减得到项目内相对路径。
    // 不做这一步时，凡「项目根路径含 symlink」的场景都会算出 `../../..` 形态的相对路径，
    // 于是所有 frontmatter `paths:` 判定必然不命中 —— 带作用域的规则全部静默失效。
    // macOS 上 `/tmp → /private/tmp` 就是这种形态，CI 与本地 fixture 常年踩中。
    // 目录形态时 realTargetDir 已经是它本身，不再拼 basename（否则会拼出 dir/dir）。
    const realAccessed = targetIsDir
      ? realTargetDir
      : join(realTargetDir, absAccessed.slice(absAccessed.lastIndexOf(sep) + 1));

    // 如果已经扫描过这个目录，跳过。
    //
    // 例外一（配合下面的 paths 作用域判定）：本目录链上存在**因作用域未命中而跳过**的
    // CLAUDE.md 时，不能把该目录记为「已扫描」——否则同目录下换一个命中作用域的文件
    // （如先读 src/ui/README.md 未命中、再读 src/ui/Footer.tsx 命中）将永远拿不到规则。
    // 这类目录留待下次触达重新判定；只有「链上全部候选都已处理完」才登记为已扫描。
    //
    // 例外二（P1-2 的成立前提）：目录级短路必须让位于新鲜度校验。`loadOne` 里的
    // mtime 比对是**目录未被登记时**才走得到的，而实际会话中「同一目录被反复访问」
    // 才是常态（改完 src/ui/CLAUDE.md 接着读 src/ui/ 下另一个文件）—— 此时短路先
    // 生效，mtime 比对一次都不执行，P1-2 在它最主要的场景里等于没做。
    // 故短路前先问一句「这条链上有没有已变更的规则」，有则放行让 loadOne 重读。
    if (this.scannedDirs.has(realTargetDir) && !this.hasStaleOnChain(realTargetDir, realRoot)) {
      return emptyDiscovery(performance.now() - startedAt);
    }
    /** 本次扫描是否遇到「因作用域未命中而跳过」的规则文件 */
    let hasScopeDeferred = false;
    let scopeSkipped = 0;

    const loaded: JitDiscovery["loaded"] = [];
    let currentDir = realTargetDir;

    // 边界判定必须按「路径段」而非字符串前缀：`startsWith(projectRoot)` 会把兄弟目录
    // `/tmp/proj-evil` 判成在 `/tmp/proj` 内（前者确实以后者开头），于是相邻项目/worktree
    // 的 CLAUDE.md 会被当作本项目规则注入——跨项目规则泄露（P0-1）。
    const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    const isInsideProject = (dir: string): boolean =>
      dir === realRoot || dir.startsWith(rootWithSep);

    // P0-2：向上遍历时**每一步都重新 realpath**。原因是 currentDir 由 dirname 逐级
    // 上溯，中途任意一级可能是 symlink（如 `proj/vendor → /other/pkg`），只在入口
    // 解引用一次挡不住「入口在项目内、祖先链爬出项目外」这种形态。
    // 同时用 visitedDirs 防 symlink 环（对齐 CC 的 visitedDirs）——环存在时
    // dirname 上溯不一定收敛，无防护会死循环。
    const visitedDirs = new Set<string>();
    /** 已评估过的候选文件 realpath（防大小写不敏感 FS 上同一 inode 被多个候选名重复计数） */
    const visitedCandidates = new Set<string>();

    while (isInsideProject(currentDir)) {
      if (visitedDirs.has(currentDir)) {
        log.debug("JIT", `目录链出现环，停止上溯: ${currentDir}`);
        break;
      }
      visitedDirs.add(currentDir);

      // ① 同目录候选文件（CLAUDE.md 族 + CLAUDE.local.md）
      const dirResult = await this.scanCandidateFiles(
        currentDir,
        realAccessed,
        realRoot,
        failures,
        visitedCandidates,
      );
      loaded.push(...dirResult.loaded);
      if (dirResult.scopeSkipped > 0) {
        hasScopeDeferred = true;
        scopeSkipped += dirResult.scopeSkipped;
      }

      // ② 同目录 .claude/rules/*.md（P1-1：主加载路径支持、JIT 侧此前完全盲区）
      const rulesResult = await this.scanRulesDir(
        join(currentDir, CLAUDE_RULES_DIR),
        realAccessed,
        realRoot,
        failures,
        visitedCandidates,
        currentDir,
      );
      loaded.push(...rulesResult.loaded);
      if (rulesResult.scopeSkipped > 0) {
        hasScopeDeferred = true;
        scopeSkipped += rulesResult.scopeSkipped;
      }

      // 向上一级目录（每步重新 realpath，见上方 P0-2 说明）
      const parentDir = safeResolvePath(dirname(currentDir));
      if (parentDir === currentDir) break; // 到达文件系统根
      currentDir = parentDir;
    }

    // 目录级扫描缓存登记：仅当本次没有「因作用域未命中而跳过」的规则时才登记。
    // 有跳过项则保持未登记，让同目录下后续访问的文件有机会重新判定作用域并拿到规则。
    if (!hasScopeDeferred) {
      this.scannedDirs.add(realTargetDir);
    }

    const elapsedMs = performance.now() - startedAt;
    if (loaded.length === 0) {
      return { text: null, loaded: [], scopeSkipped, failures, elapsedMs };
    }

    const text = loaded.map((l) => this.loaded.get(l.path)!.formatted).join("\n\n");
    return { text, loaded, scopeSkipped, failures, elapsedMs };
  }

  /**
   * 目录链上是否存在「磁盘已变更 / 已消失」的已加载规则（P1-2 的短路豁免判据）。
   *
   * 只看**本次会走到的那条目录链**（targetDir 逐级上溯到项目根），不是全量扫 `loaded`
   * —— 后者会让「改了 A 目录的规则」把 B 目录的短路也一起放行，白跑一遍扫描。
   *
   * 代价是每次命中短路时多做 N 次 `statSync`（N = 链上已加载的规则数，通常 1-3）。
   * 相比之下漏掉新鲜度校验的代价是「整个会话都在用旧规则」，这个 trade-off 不难选。
   * 且它只在**已登记短路**的路径上执行，未登记时本来就要读盘，不构成额外开销。
   */
  private hasStaleOnChain(targetDir: string, realRoot: string): boolean {
    if (this.loaded.size === 0) return false;

    // 收集本次链上的目录集合（与 discoverDetailed 的上溯口径一致：realpath + 边界内）
    const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    const chain = new Set<string>();
    let cur = targetDir;
    while (cur === realRoot || cur.startsWith(rootWithSep)) {
      if (chain.has(cur)) break; // symlink 环防护，与主循环同一考量
      chain.add(cur);
      const parent = safeResolvePath(dirname(cur));
      if (parent === cur) break;
      cur = parent;
    }

    for (const [key, entry] of this.loaded) {
      // 只关心归属在本条链上的规则。`ownerDir` 为空串是旧快照（不应出现）→ 保守跳过。
      if (!entry.ownerDir || !chain.has(entry.ownerDir)) continue;
      const stamp = fileStamp(key);
      // mtimeMs=0 表示 stat 失败 / 文件消失。此处**不**当作 stale：
      // 与 `loadOne` 的退化策略保持一致（那里 stamp=0 判 unchanged），否则文件被删后
      // 每次访问都放行、每次又读不到，白扫一遍还刷日志。删除场景由 `pruneStale` 负责。
      if (stamp.mtimeMs === 0) continue;
      if (entry.mtimeMs !== stamp.mtimeMs || entry.size !== stamp.size) return true;
    }
    return false;
  }

  /**
   * 向后兼容的简化入口：只返回注入文本。
   * 新代码请用 `discoverDetailed`（带埋点所需的结构化明细）。
   */
  async discoverContext(accessedPath: string, projectRoot: string): Promise<string | null> {
    const r = await this.discoverDetailed(accessedPath, projectRoot);
    return r.text;
  }

  /**
   * 扫描单个目录下的候选规则文件。
   *
   * 关键（P1-5）：作用域未命中时 **`continue` 而非 `break`**。原实现 break 跳出的是
   * 整个候选文件名循环，导致一份带 `paths:` 的 `CLAUDE.md` 未命中会让同目录的
   * **无条件** `.claude/CLAUDE.md` / `.claude/instructions.md` 永远拿不到。
   * CC 把条件规则与无条件规则拆成两个独立 pass，本质相同：两类互不干扰。
   *
   * 「同目录多份候选只取第一份」的语义仍保留（`hitInThisDir` 短路），避免重复注入。
   */
  private async scanCandidateFiles(
    dir: string,
    activeAbsPath: string,
    realRoot: string,
    failures: JitDiscovery["failures"],
    /** 本次发现已评估过的候选 realpath，跨目录共享（防同一物理文件被重复计数） */
    visitedCandidates: Set<string>,
  ): Promise<{ loaded: JitDiscovery["loaded"]; scopeSkipped: number }> {
    const loaded: JitDiscovery["loaded"] = [];
    let scopeSkipped = 0;
    /** 本目录是否已注入过一份（同目录多候选只取第一份，避免重复注入） */
    let hitInThisDir = false;

    for (const filename of JIT_CANDIDATE_FILES) {
      if (hitInThisDir) break; // ← 有意的 break：同目录只取第一份（非作用域相关）
      const candidatePath = join(dir, filename);
      if (!existsSync(candidatePath)) continue;

      // 同一物理文件只评估一次。
      //
      // 大小写不敏感 FS（默认 macOS APFS / Windows NTFS）上 `CLAUDE.md`、`claude.md`、
      // `.claude.md` 中的多个候选名会命中**同一个** inode，`existsSync` 全为 true。
      // 不去重的后果不只是重复注入（那由 loadOne 的 realpath 去重挡住了），更关键的是
      // **`scopeSkipped` 被重复计数**：一份带 paths 的规则未命中会记 2-3 次跳过，
      // 让 P1-3 埋点的「浪费率」直接虚高数倍 —— 埋点数据错了，据此做的优化判断也就错了。
      const candidateReal = safeResolvePath(candidatePath);
      if (visitedCandidates.has(candidateReal)) continue;
      visitedCandidates.add(candidateReal);

      const isLocal = (CLAUDE_LOCAL_FILES as readonly string[]).includes(filename);
      const outcome = await this.loadOne(
        candidatePath,
        activeAbsPath,
        realRoot,
        isLocal ? "local" : "nested_traversal",
        failures,
        dir, // ownerDir：命中它的那一级祖先目录（不是 dirname —— `.claude/CLAUDE.md` 的 dirname 是 .claude）
      );
      if (outcome.kind === "loaded") {
        loaded.push(outcome.entry);
        hitInThisDir = true;
      } else if (outcome.kind === "scope-miss") {
        // P1-5：只跳过这一个候选，继续检查同目录其余候选（无条件规则不该被连带抑制）
        scopeSkipped++;
      }
      // kind === "already" / "failed" → 继续下一个候选
    }

    return { loaded, scopeSkipped };
  }

  /**
   * 扫描 `.claude/rules/` 目录下的 *.md（P1-1）。
   *
   * 与 `rules.ts:loadRulesFromDir` 同语义：跟随 symlink + realpath 去重防环。
   * 与候选文件不同，rules 目录下**每一份都独立判定并全部注入**（不是「只取第一份」）
   * —— 主加载路径就是这个语义（`loadRulesFromDir` 逐文件 push），JIT 侧必须一致。
   */
  private async scanRulesDir(
    rulesDir: string,
    activeAbsPath: string,
    realRoot: string,
    failures: JitDiscovery["failures"],
    /** 与 scanCandidateFiles 共享：同一物理文件跨候选名/跨目录只评估一次 */
    visitedCandidates: Set<string>,
    /** 本 rules 目录归属的那一级祖先目录（`.claude/rules` 的上两级），供新鲜度上链判定 */
    ownerDir: string,
  ): Promise<{ loaded: JitDiscovery["loaded"]; scopeSkipped: number }> {
    const log = getLogger();
    const loaded: JitDiscovery["loaded"] = [];
    let scopeSkipped = 0;
    if (!existsSync(rulesDir)) return { loaded, scopeSkipped };

    let entries: string[];
    try {
      entries = await Array.fromAsync(
        new Bun.Glob("**/*.md").scan({ cwd: rulesDir, onlyFiles: true, followSymlinks: true }),
      );
    } catch (err: any) {
      log.debug("JIT", `扫描规则目录失败: ${rulesDir} (${err?.message})`);
      return { loaded, scopeSkipped };
    }
    entries.sort(); // 稳定顺序，避免注入文本随 FS 遍历顺序抖动（伤 prompt cache）

    for (const rel of entries) {
      const full = join(rulesDir, rel);
      const fullReal = safeResolvePath(full);
      if (visitedCandidates.has(fullReal)) continue;
      visitedCandidates.add(fullReal);
      const outcome = await this.loadOne(
        full,
        activeAbsPath,
        realRoot,
        "rules_dir",
        failures,
        ownerDir,
      );
      if (outcome.kind === "loaded") loaded.push(outcome.entry);
      else if (outcome.kind === "scope-miss") scopeSkipped++;
    }

    return { loaded, scopeSkipped };
  }

  /**
   * 加载单份规则文件：realpath 去重 → 新鲜度校验 → 读盘 → @import 展开 →
   * frontmatter 作用域判定 → 格式化并登记。
   */
  private async loadOne(
    candidatePath: string,
    activeAbsPath: string,
    realRoot: string,
    reason: JitDiscovery["loaded"][number]["reason"],
    failures: JitDiscovery["failures"],
    /** 命中本份规则的那一级祖先目录（realpath），存进快照供 `hasStaleOnChain` 上链判定 */
    ownerDir: string,
  ): Promise<
    | { kind: "loaded"; entry: JitDiscovery["loaded"][number] }
    | { kind: "already" }
    | { kind: "scope-miss" }
    | { kind: "failed" }
  > {
    const log = getLogger();
    // realpath 去重键（不小写化）：同一份文件经不同 symlink 触达时只加载一次
    const key = safeResolvePath(candidatePath);

    // ── P1-2 新鲜度校验 ──
    // 已加载过时不是无条件跳过：比对 mtime + size，磁盘上变了就重新读盘并更新快照。
    // 这保住了「压缩后即时回灌」这一对 CC 的真实领先（不必等下次触达才重读），
    // 同时消除陈旧快照 —— 即 §3 建议的 A+B 混合中的 A 半。
    const prev = this.loaded.get(key);
    const stamp = fileStamp(candidatePath);
    if (prev) {
      const unchanged =
        // stamp 取不到（mtimeMs=0）时退化为「不重读」，避免 stat 失败导致每轮重复注入
        stamp.mtimeMs === 0 || (prev.mtimeMs === stamp.mtimeMs && prev.size === stamp.size);
      if (unchanged) return { kind: "already" };
      log.info("JIT", `规则文件已变更，重新加载: ${candidatePath}`);
    }

    let rawContent: string;
    try {
      rawContent = await Bun.file(candidatePath).text();
    } catch (err: any) {
      // P2-8：区分 ENOENT（正常：候选竞态被删）与真实错误（EACCES / 编码 / IO）
      const code = String(err?.code ?? "EUNKNOWN");
      if (code !== "ENOENT") {
        failures.push({
          path: candidatePath,
          code,
          phase: "read",
          message: String(err?.message ?? err),
        });
        log.warn("JIT", `读取规则文件失败 [${code}]: ${candidatePath}`, err);
      } else {
        log.debug("JIT", `规则文件已不存在（竞态），跳过: ${candidatePath}`);
      }
      return { kind: "failed" };
    }

    // frontmatter `paths:` 作用域判定（与主加载路径 loadAllCLAUDEmd 同语义）。
    //
    // 这是 paths 机制真正生效的地方：主加载路径在启动时没有「当前活动文件」，
    // 带 paths 的规则一律不注入；JIT 拿到的 accessedPath 才是确切的活动文件，
    // 用它判定作用域——命中才注入。这样 `paths: ["src/ui/**"]` 的 TUI 规范
    // 只在真正读写 src/ui 下文件时进入上下文，在 website/ 里做文档任务时不会出现。
    //
    // 注意 body：注入的是剥离 frontmatter 后的正文，避免把 `paths:` 元数据喂给模型。
    const { paths, body } = parseRulesFrontmatter(rawContent);
    let effectiveReason = reason;
    if (paths && paths.length > 0) {
      // activeFiles 用相对项目根的 posix 风格路径（与 rulesPathsMatch 的 glob 口径一致）
      const activeFile = relative(realRoot, activeAbsPath).split(sep).join("/");
      if (!rulesPathsMatch(paths, [activeFile])) {
        log.debug(
          "JIT",
          `规则 paths 作用域未命中，跳过: ${candidatePath} (paths=${JSON.stringify(paths)}, activeFile=${activeFile})`,
        );
        return { kind: "scope-miss" };
      }
      // 命中作用域 → 归因改为 path_glob_match（对齐 CC 的 load_reason 语义）
      effectiveReason = "path_glob_match";
    }

    // @import 递归展开（外部导入门禁：只允许项目根内，越界经 recordSkippedExternalImport 记录）
    let expanded = body;
    try {
      // 外部导入门禁：只允许项目根内；越界者按 externalApproved 批准位决定展开或跳过，
      // 跳过的经 recordSkippedExternalImport 登记，供上层弹审批 / 注入 reminder。
      // 与主加载路径（rules.ts:loadAndParse）同一套语义，不得只在一侧生效。
      let externalApproved = false;
      try {
        externalApproved = getClaudeMdExternalImportsApproved(realRoot) === true;
      } catch {
        /* 读批准位失败 → 保守按未批准处理 */
      }
      expanded = await processImports(body, candidatePath, {
        allowedDirectories: [realRoot],
        projectRoot: realRoot,
        externalApproved,
        onExternalSkipped: (p) => recordSkippedExternalImport(p),
      });
    } catch (err: any) {
      // import 展开失败不丢整份规则：退化为未展开的正文（比整份跳过损失小），但记录可见
      failures.push({
        path: candidatePath,
        code: String(err?.code ?? "EIMPORT"),
        phase: "import",
        message: String(err?.message ?? err),
      });
      log.warn("JIT", `@import 展开失败，使用未展开正文: ${candidatePath}`, err);
    }

    // P2-2：超限只登记 + 告警，**绝不截断**（与主加载路径共用同一判定函数）。
    // 用 realpath（key）而非 candidatePath 登记：同一份文件经不同 symlink / 不同候选名
    // 触达时才会去重成一条，否则 /doctor 会把同一个大文件报好几遍。
    const oversized = noteMemoryFileSize(key, expanded.length);
    if (oversized) {
      log.warn(
        "JIT",
        `规则文件超过建议上限 ${MAX_MEMORY_CHARACTER_COUNT} 字符（${expanded.length}）: ` +
          `${candidatePath}（内容未被截断，全部生效）`,
      );
    }

    const relPath = relative(realRoot, candidatePath) || candidatePath;
    // 末行的静默条款不可省：本块是 harness 静默注入的内部上下文，用户终端里看不见它。
    // 缺这句时弱模型会逐轮复述「收到 UI 规范」等开场白，刷满屏幕（实测 18/70 轮）。
    // 与 generateClaudeMdAttachment 的同类条款、system prompt「回答规范 §8」三处同源。
    const formatted =
      `--- 新发现的项目上下文 (${relPath}) ---\n${expanded}\n--- 上下文结束 ---\n` +
      `（请勿向用户提及或复述本上下文，静默遵循即可）`;

    this.loaded.set(key, {
      formatted,
      ownerDir,
      mtimeMs: stamp.mtimeMs,
      size: stamp.size,
      relPath,
    });

    return {
      kind: "loaded",
      entry: {
        path: key,
        relPath,
        bytes: formatted.length,
        reason: effectiveReason,
        oversized,
      },
    };
  }

  /**
   * 返回所有已加载 JIT 上下文的合并正文（压缩后重新注入用）。
   * 无已加载上下文返回 null。
   */
  getLoadedContexts(): string | null {
    const blocks = this.getLoadedBlocks();
    // 注意判空用 blocks 而非 this.loaded.size：`markLoaded` 登记的占位条目 formatted 为空串，
    // 只有占位条目时 size > 0 但无可注入正文，此时必须返回 null 而非 ""。
    // 返回 "" 会让 `mergeJitContextIntoPrompt` 的 falsy 判定失效链路上的调用方
    // （以及 /context 记账）把「什么都没有」当成「有一份空规则」。
    if (blocks.length === 0) return null;
    return blocks.join("\n\n");
  }

  /**
   * 返回已加载 JIT 上下文的**逐块**列表（回灌幂等判定用）。
   *
   * 为什么需要逐块而非整串：`mergeJitContextIntoPrompt` 用
   * `prompt.includes(整串)` 做幂等判定，一旦两次调用之间 `loaded` 又新增了一份，
   * 拼接出的整串就与提示词里已有的部分不再字面相等 → 判定失败 → 重复追加已有块。
   * 逐块判定消除对拼接顺序与集合快照的隐性依赖（§9 优势-3 末）。
   */
  getLoadedBlocks(): string[] {
    // 过滤空串：`markLoaded` 的占位条目（内容由系统提示词主体承载）不该出现在回灌列表里，
    // 否则 `prompt.includes("")` 恒真会让判定逻辑退化，且给记账加上 0 长度的假条目。
    return Array.from(this.loaded.values())
      .map((e) => e.formatted)
      .filter((f) => f.length > 0);
  }

  /** 已加载 JIT 上下文的总字节数（P1-7：进 setMemoryTokens 记账用） */
  getLoadedBytes(): number {
    let total = 0;
    for (const e of this.loaded.values()) total += e.formatted.length;
    return total;
  }

  /**
   * 重置缓存（P2-7 的调用时机：`/clear` + compact + 会话恢复）。
   *
   * 语义对齐 CC 的 lazy re-inject（`compact.ts:521` + `clear/conversation.ts:132`
   * 的 `loadedNestedMemoryPaths?.clear()`）：清去重记录 → 下次触达重新读盘。
   * 注意与「压缩后回灌」的协调：compact 路径是**先回灌再 reset**，否则会把刚清掉的
   * 内容又灌回去；`/clear` 路径系统提示词整体重建，直接 reset。
   */
  reset(): void {
    this.loaded.clear();
    this.scannedDirs.clear();
  }

  /**
   * 丢弃磁盘上已变更 / 已删除的条目（P1-2 + P2-7，压缩前调用）。
   *
   * ## 为什么是 prune 而不是 CC 的全量 clear
   *
   * CC 在 compact 时 `loadedNestedMemoryPaths.clear()`，语义是 lazy re-inject：
   * 下次触达该目录才重读。代价是**压缩后到下次触达之间那段窗口，规则不在上下文里**
   * —— 而压缩恰恰是模型最容易"忘记规则"的时刻（消息历史被摘要抹平了）。
   *
   * 我们保留「压缩后立即回灌」这一领先，同时补上 CC 靠 clear 免疫的陈旧问题：
   * 回灌**之前**先按 mtime/size 剔掉已变更的条目。被剔掉的不回灌，留给下次触达
   * 重新读盘 + 重新判定作用域（作用域判定需要"当前活动文件"，压缩时没有，
   * 所以只能延后到触达时——这也是不能在这里直接重读的原因）。
   *
   * @returns 被剔除的条目数
   */
  pruneStale(): number {
    const log = getLogger();
    let pruned = 0;
    for (const [key, entry] of [...this.loaded.entries()]) {
      const stamp = fileStamp(key);
      if (stamp.mtimeMs === 0) {
        // 文件已删除 / 不可 stat：注入内容已无对应磁盘事实，丢弃（不回灌陈旧规则）
        this.loaded.delete(key);
        this.scannedDirs.delete(safeResolvePath(dirname(key)));
        pruned++;
        log.info("JIT", `规则文件已消失，丢弃其缓存: ${entry.relPath}`);
        continue;
      }
      if (entry.mtimeMs !== stamp.mtimeMs || entry.size !== stamp.size) {
        this.loaded.delete(key);
        this.scannedDirs.delete(safeResolvePath(dirname(key)));
        pruned++;
        log.info("JIT", `规则文件已变更，丢弃旧快照待重读: ${entry.relPath}`);
      }
    }
    return pruned;
  }

  /**
   * 让单份文件的快照失效（P1-2 方案 A：watcher 变更事件驱动）。
   *
   * 与 `reset()` 同族：`reset` 是全量、`invalidate` 是单点。watcher 只知道
   * 「哪个文件变了」，用它精确失效即可，不必让整个会话的 JIT 缓存作废。
   * 同时清掉该文件所在目录的 `scannedDirs` 登记，否则目录被记为已扫描后
   * 下次触达会直接短路、永远不会重新读这份文件。
   *
   * @returns 是否确实命中并清除了一条记录
   */
  invalidate(filePath: string): boolean {
    let abs: string;
    try {
      abs = normalizeToolPath(filePath);
    } catch {
      return false;
    }
    const key = safeResolvePath(abs);
    const hit = this.loaded.delete(key);
    // 目录登记一并清除（含 .claude/rules/x.md 这类嵌套形态：逐级上溯清到项目根开销过大，
    // 只清直接父目录与其 .claude 祖先两级，覆盖全部候选形态）
    this.scannedDirs.delete(safeResolvePath(dirname(key)));
    this.scannedDirs.delete(safeResolvePath(dirname(dirname(key))));
    return hit;
  }

  /**
   * 预填充已加载的 CLAUDE.md 路径（避免 JIT 重复发现首轮已注入的文件）。
   * app 初始化时调用：把 loadAllCLAUDEmd 已加载的文件路径标记为"已处理"，
   * 后续 discoverContext 向上查找时遇到这些文件会跳过。
   *
   * 注意：这里登记的是「已在别处注入」的占位条目——`formatted` 为空串，
   * 故不会出现在 `getLoadedContexts()` / `getLoadedBytes()` 的统计里
   * （那些内容由系统提示词主体承载，重复记账会让压缩阈值虚高）。
   * mtime 仍然记录，使会话中途修改这些文件时 JIT 能接手重新注入。
   */
  markLoaded(filePaths: string[]): void {
    for (const p of filePaths) {
      let abs: string;
      try {
        abs = normalizeToolPath(p);
      } catch {
        continue;
      }
      const key = safeResolvePath(abs);
      if (this.loaded.has(key)) continue;
      const stamp = fileStamp(key);
      // ownerDir 取「候选文件所归属的那一级目录」：`.claude/CLAUDE.md`、
      // `.claude/rules/x.md` 这类嵌套形态要还原到外层目录，否则它们的 mtime 变化
      // 永远上不了目录链、`hasStaleOnChain` 判不出 stale，JIT 接不了手（P1-7）。
      this.loaded.set(key, {
        formatted: "",
        ownerDir: ownerDirOf(key),
        mtimeMs: stamp.mtimeMs,
        size: stamp.size,
        relPath: p,
      });
    }
  }

  /** 获取已加载的文件数量（仅供调试 / 测试，无生产消费方） */
  getLoadedCount(): number {
    return this.loaded.size;
  }
}
