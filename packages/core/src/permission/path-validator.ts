/**
 * 路径验证器
 * 集中处理：symlink 解析 + 工作区边界检查 + 系统目录保护 + 敏感文件检测
 * 替代 checker.ts 中分散的 checkPathSecurity / checkDirectoryAccess 逻辑
 *
 * 纵深防御（对标 claude-code filesystem.ts / pathValidation.ts）：
 *   Unicode 净化 → 大小写归一化 → Windows 绕过 → UNC 拦截 → 三点路径 →
 *   目录黑名单 → 目录白名单 → 系统目录 → symlink 多路径链逃逸 →
 *   敏感文件 → 工作目录边界
 *
 * ⚠️ 末尾两步的顺序不能对调：敏感文件必须是硬 deny，排在「工作目录边界」之前。
 * 反过来的话，工作区外的 `.env` / `*.pem` 会先落到边界分支拿到 needsConfirmation，
 * 从「不可放行」退化成「点一下允许就能读」——那是把 SEC-AUDIT-2026-07-19 P2 的收紧退回去。
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { hasDangerousUnicode } from "@sid-code/shared/utils/sanitization.ts";

/** 路径验证结果 */
export interface PathValidationResult {
  allowed: boolean;
  reason?: string;
  needsConfirmation?: boolean;
  /** symlink 解析后的真实路径 */
  resolvedPath: string;
  /**
   * true 表示命中敏感文件（凭证类）规则（SEC-AUDIT-2026-07-19 P2）。
   *
   * checker 据此判断「这条硬 deny 是否允许被用户显式 allow 规则解除」——
   * 敏感文件 deny 可解除（用户在 settings.json 里写 `Read(.env)`），
   * 而系统目录/symlink 逃逸那类 deny 不可解除。
   */
  sensitiveFile?: boolean;
  /**
   * true 表示命中「工作目录边界」检查（工作区 ∪ `--add-dir` 追加目录之外）。
   *
   * 与 sensitiveFile 的区别：这一类是 **needsConfirmation**（可被用户显式 allow 规则
   * 或当轮确认放行），不是硬 deny。checker 据此决定「这条路径拒绝是否也能走
   * allow 规则逃生舱」——不给这个口子，用户对「工作区外读写」就没有任何配置途径。
   */
  outsideWorkingDirs?: boolean;
}

/**
 * 路径大小写归一化（对标 claude-code filesystem.ts:90 normalizeCaseForComparison）。
 *
 * macOS（APFS/HFS+ 默认大小写不敏感）与 Windows（NTFS 默认大小写不敏感）下，
 * `.ClAuDe/settings.json` 与 `.claude/settings.json` 指向同一文件，但 startsWith /
 * 正则的字面量比较会漏判。所有"用于比较的"路径在比较前先经此函数归一化为全小写，
 * 杜绝大小写混淆绕过。
 *
 * 注意：仅用于"比较"，绝不用归一化后的路径做实际文件操作（那会破坏大小写敏感文件系统）。
 */
export function normalizeCaseForComparison(p: string): string {
  return p.toLowerCase();
}

/**
 * 判断（已归一化小写的）路径是否落在某目录内，含目录本身。
 *
 * 为什么不直接用 `startsWith(dir + "/")`：`dir === "/"` 时前缀拼成 `"//"`，
 * 任何绝对路径都不匹配 —— `--add-dir /` 会变成一个永远不生效的白名单项，
 * `blockedDirectories: ["/"]` 也永不拦截（fail-open）。这里先归一化尾斜杠，
 * 根目录退化成 `startsWith("/")`，仍然只匹配绝对路径。
 */
function isPathWithinDir(pathLower: string, dirLower: string): boolean {
  const prefix = dirLower.endsWith("/") ? dirLower : `${dirLower}/`;
  return pathLower === dirLower || pathLower.startsWith(prefix);
}

/** 系统目录保护（写入拦截）— 包含 macOS /private 前缀 */
const PROTECTED_WRITE_DIRS = [
  "/etc/",
  "/usr/",
  "/bin/",
  "/sbin/",
  "/boot/",
  "/proc/",
  "/sys/",
  "/dev/",
  "/var/log/",
  "/System/",
  "/Library/",
  "/private/etc/",
  "/private/var/log/",
];

/** 系统目录保护（读取拦截）— 包含 macOS /private 前缀 */
const PROTECTED_READ_DIRS = ["/proc/", "/sys/", "/dev/"];

/** 敏感文件模式 */
export const SENSITIVE_FILES = [
  /\.env$/,
  /\.env\..+/,
  /credentials/i,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /id_rsa/,
  /id_ed25519/,
  /\.ssh\//,
  /password/i,
  /secret/i,
  /\.aws\/config/,
  // .aws/credentials 单列（SEC-AUDIT-2026-07-19 P2）：虽然通用 /credentials/i 已能覆盖，
  // 但显式列出让「云厂商凭证」这条意图在清单里可见，也防后续有人收窄通用模式时误伤。
  /\.aws\/credentials/,
  /\.kube\/config/,
  /\.docker\/config\.json/,
  /\.npmrc$/,
  /\.pypirc$/,
  /\.netrc$/,
  /\.git-credentials/,
  /token\.json/i,
];

/**
 * Windows 路径绕过模式（跨平台防御）。
 * 即使当前运行在 macOS/Linux，路径仍可能来自 LLM 生成——LLM 不区分平台，
 * 可能产出这些可绕过 Windows 文件系统语义的特殊形态。统一拦截，宁严勿松。
 */
const WINDOWS_BYPASS_PATTERNS: Array<{ pattern: RegExp; desc: string }> = [
  { pattern: /::\$[A-Za-z]+/i, desc: "NTFS 备用数据流 (::$DATA)" },
  { pattern: /~\d/, desc: "8.3 短名称 (PROGRA~1)" },
  // 长路径前缀（对标 filesystem.ts：\\?\ / \\.\ / //?/ / //./ 四种变体，原先仅覆盖 \\?\）
  { pattern: /^\\\\\?\\/, desc: "长路径前缀 (\\\\?\\)" },
  { pattern: /^\\\\\.\\/, desc: "设备路径前缀 (\\\\.\\)" },
  { pattern: /^\/\/\?\//, desc: "长路径前缀 POSIX 变体 (//?/)" },
  { pattern: /^\/\/\.\//, desc: "设备路径前缀 POSIX 变体 (//./)" },
  // 尾随点/空格：要求前面有真实文件名字符，避免误伤 "." / ".." 目录引用
  { pattern: /[^.\\/ ][. ]+$/, desc: "尾随点/空格（Windows 静默去除）" },
  // DOS 设备名 — 含扩展名变体（对标 filesystem.ts:581-582，如 NUL.txt / CON.log）
  { pattern: /(^|[\\/])(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.[^\\/]*)?($|[\\/])/i, desc: "DOS 设备名" },
];

/**
 * UNC 路径模式（对标 claude-code filesystem.ts containsVulnerableUncPath + readOnlyCommandValidation）。
 * UNC 路径（\\server\share、//server/share）会访问远程文件，绕过本地工作区边界。
 * 全平台拦截：即使运行在 macOS/Linux，LLM 生成的 UNC 路径也应拒绝。
 */
const UNC_PATTERNS: Array<{ pattern: RegExp; desc: string }> = [
  { pattern: /^\\\\[^\\]+\\/, desc: "UNC 共享路径 (\\\\server\\share)" },
  { pattern: /^\/\/[^/]+\//, desc: "UNC 共享路径 POSIX 变体 (//server/share)" },
  { pattern: /^\\\\\d+\.\d+\.\d+\.\d+/, desc: "UNC IP 共享路径 (\\\\192.168.x.x)" },
];

/**
 * 三点（及以上）路径混淆模式（对标 claude-code filesystem.ts:590）。
 * `...` / `....` 这类多点段不是标准 `..`，部分文件系统/解析器会做意外归约，
 * 是路径遍历绕过的常见变体。统一拦截。
 */
const TRIPLE_DOT_PATTERN = /(^|\/|\\)\.{3,}(\/|\\|$)/;

/** 检测路径是否命中 Windows 绕过模式，返回命中的描述（未命中返回 null） */
function detectWindowsBypass(filePath: string): string | null {
  for (const { pattern, desc } of WINDOWS_BYPASS_PATTERNS) {
    if (pattern.test(filePath)) return desc;
  }
  return null;
}

/** 检测 UNC 路径，返回命中的描述（未命中返回 null） */
function detectUncPath(filePath: string): string | null {
  for (const { pattern, desc } of UNC_PATTERNS) {
    if (pattern.test(filePath)) return desc;
  }
  return null;
}

/** 敏感文件匹配：原路径、小写路径、补尾斜杠（目录形态）三路都试。 */
export function matchesSensitivePath(realPath: string, realPathLower?: string): boolean {
  const lower = realPathLower ?? normalizeCaseForComparison(realPath);
  const withSlash = lower.endsWith("/") ? lower : `${lower}/`;
  for (const pattern of SENSITIVE_FILES) {
    const target = pattern.flags.includes("i") ? realPath : lower;
    const fallback = pattern.flags.includes("i") ? null : realPath;
    if (pattern.test(target) || (fallback !== null && pattern.test(fallback))) return true;
    if (pattern.test(withSlash)) return true;
  }
  return false;
}

/**
 * 白名单目录的两种写法。
 *
 * 为什么要存两份：`validateAccess` 里同时存在两种口径的路径——
 * `resolved = path.resolve(filePath)`（**未** realpath）与 `realPath = resolveRealPath(...)`
 * （已 realpath）。而工作区/白名单在构造时是 realpath 过的。macOS 上 `/var → /private/var`、
 * `/tmp → /private/tmp`，`os.tmpdir()` 返回的正是 `/var/folders/…/T`，于是同一个物理目录
 * 有了两种写法：拿未 realpath 的 `resolved` 去比已 realpath 的白名单，恒为 false ——
 * symlink 逃逸检测（第 4 步）的入口条件因此整体失效，检测形同不存在。
 *
 * 两种形态指向**同一个物理位置**，双形态比较只是消除写法差异，不引入集合外的路径：
 * 任何既不在真实前缀、也不在其别名前缀下的路径仍然判为集合外。
 */
interface AllowedDirEntry {
  /** realpath 形态（存在则 realpathSync，否则 resolve） */
  real: string;
  /** path.resolve 原样形态（未 realpath） */
  resolved: string;
}

export class PathValidator {
  private workspacePath: string;
  /** 工作区路径的归一化（全小写）形式，供大小写不敏感文件系统比较使用 */
  private workspacePathLower: string;
  /**
   * 工作区在 `path.resolve` 口径下的小写形态（未 realpath）。
   * 与 workspacePathLower 是同一目录的两种写法，见 AllowedDirEntry 的注释。
   */
  private workspaceResolvedLower: string;
  private allowedDirectories: AllowedDirEntry[];
  private blockedDirectories: string[];

  constructor(
    workspacePath: string,
    allowedDirectories: string[] = [],
    blockedDirectories: string[] = [],
  ) {
    // 对工作区路径也做 realpath 解析，确保 macOS /tmp → /private/tmp 等场景一致
    const resolved = path.resolve(workspacePath);
    try {
      this.workspacePath = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
    } catch {
      this.workspacePath = resolved;
    }
    this.workspacePathLower = normalizeCaseForComparison(this.workspacePath);
    this.workspaceResolvedLower = normalizeCaseForComparison(resolved);
    this.allowedDirectories = allowedDirectories.map((d) => this.normalizeDirEntry(d));
    this.blockedDirectories = blockedDirectories.map((d) => {
      const r = path.resolve(d);
      try {
        return fs.existsSync(r) ? fs.realpathSync(r) : r;
      } catch {
        return r;
      }
    });
  }

  /**
   * 验证文件路径访问权限
   * 综合检查：Unicode → Windows 绕过 → UNC → 三点路径 → 目录黑名单 → 目录白名单
   *   → 系统目录 → symlink 多路径链逃逸 → 敏感文件 → 工作目录边界
   */
  validateAccess(filePath: string, operation: "read" | "write"): PathValidationResult {
    const resolved = path.resolve(filePath);
    const realPath = this.resolveRealPath(filePath);

    // 0. Unicode 净化预检查：拦截零宽空格 / 方向控制符等不可见字符
    //    （这些字符让用户「看到」的路径与实际值不符，是混淆攻击的常见手法）
    if (hasDangerousUnicode(filePath)) {
      return {
        allowed: false,
        reason: `路径包含危险的不可见 Unicode 字符: ${filePath}`,
        needsConfirmation: true,
        resolvedPath: realPath,
      };
    }

    // 0.1 Windows 路径绕过检测（跨平台防御，详见 WINDOWS_BYPASS_PATTERNS）
    const bypass = detectWindowsBypass(filePath);
    if (bypass) {
      return {
        allowed: false,
        reason: `路径命中 Windows 绕过模式（${bypass}）: ${filePath}`,
        needsConfirmation: true,
        resolvedPath: realPath,
      };
    }

    // 0.2 UNC 路径拦截（全平台防御，远程文件访问绕过工作区边界）
    const unc = detectUncPath(filePath);
    if (unc) {
      return {
        allowed: false,
        reason: `路径命中 UNC 远程共享模式（${unc}）: ${filePath}`,
        needsConfirmation: true,
        resolvedPath: realPath,
      };
    }

    // 0.3 三点路径混淆拦截（对标 filesystem.ts:590）
    if (TRIPLE_DOT_PATTERN.test(filePath)) {
      return {
        allowed: false,
        reason: `路径含三点混淆段（路径遍历绕过）: ${filePath}`,
        needsConfirmation: true,
        resolvedPath: realPath,
      };
    }

    // 1. 目录黑名单（最高优先级，大小写归一化比较防绕过）
    const realPathLower = normalizeCaseForComparison(realPath);
    for (const blocked of this.blockedDirectories) {
      const blockedLower = normalizeCaseForComparison(blocked);
      if (isPathWithinDir(realPathLower, blockedLower)) {
        return {
          allowed: false,
          reason: `目录被禁止访问: ${blocked}`,
          resolvedPath: realPath,
        };
      }
    }

    // 2. 目录白名单（如果配置了，大小写归一化比较）
    //
    // 判据是「工作目录集合」= 工作区 ∪ 白名单，而不是「白名单」本身。
    // 白名单语义是**追加**（--add-dir / /add-dir 的文案都是「追加可访问目录」），
    // 若只查白名单，加了第一个目录就等于把工作区从可访问集合里挤出去：
    // 工作区路径在这里被硬拒（needsConfirmation 未设，不转确认），
    // 交互里敲一次 /add-dir 会让下一轮连自己的工作区都读不了。
    //
    // 外层 length > 0 必须保留，但理由不是「维持区外可读」—— 那是本修复之前的
    // 注释口径，读边界后来由「工作目录边界」那一步统一管（读也查，返回
    // needsConfirmation）。这里保留外层判断的真实差别是**拒绝强度**：
    //   · 白名单非空：落在集合外 → 硬拒（needsConfirmation 未设，无头/交互都不可放行）
    //   · 白名单为空：这一步不生效，集合外的路径由后面的边界检查返回 needsConfirmation
    // 用户既然用 --add-dir / settings 显式限定了可访问目录，集合外就不该留
    // 「点一下就放行」的口子。反过来，无条件走集合判断会把这个强度差别抹平。
    if (this.allowedDirectories.length > 0) {
      if (!this.isWithinWorkingDirectories(realPath)) {
        return {
          allowed: false,
          // 文案保持「不在白名单中」：触发时 realPath 确实既不在工作区、也不在白名单，
          // 这句话不失真。改措辞会连带打断三处既有断言（含「拒绝原因须说给模型」那条），
          // 与本修复无关。
          reason: "目录不在白名单中",
          resolvedPath: realPath,
        };
      }
    }

    // 3. 系统目录保护（优先于工作区边界，因为系统目录信息更具体；大小写归一化比较）
    if (operation === "write") {
      for (const protectedDir of PROTECTED_WRITE_DIRS) {
        if (realPathLower.startsWith(normalizeCaseForComparison(protectedDir))) {
          return {
            allowed: false,
            reason: `系统目录写入被拦截: ${realPath}`,
            needsConfirmation: true,
            resolvedPath: realPath,
          };
        }
      }
    } else {
      for (const protectedDir of PROTECTED_READ_DIRS) {
        if (realPathLower.startsWith(normalizeCaseForComparison(protectedDir))) {
          return {
            allowed: false,
            reason: `系统目录读取被拦截: ${realPath}`,
            needsConfirmation: true,
            resolvedPath: realPath,
          };
        }
      }
    }

    // 4. symlink 多路径链逃逸检测：原始路径在工作目录集合内，但解析链上任一环逃逸到集合外
    //    （对标 claude-code getPathsForPermissionCheck —— 不止检查最终 realpath，
    //     还要检查从原始路径到 realpath 的每一个中间解析环节，
    //     防止 workdir/safe → symlink → /etc/passwd 这种中间环节逃逸）
    //
    // 判据是「工作目录集合」而不是「工作区」：追加目录（--add-dir）里的文件同样允许写入，
    // 从它出发的 symlink 必须进这道检测；反过来，工作区里指向追加目录的 symlink
    // 也不该被误判成逃逸。
    if (resolved !== realPath) {
      const originalInWorkingDirs = this.isWithinWorkingDirectories(resolved);
      if (originalInWorkingDirs) {
        const chain = this.getAllResolvedPaths(filePath);
        // 逃逸 = 链上某一环既不在工作目录集合内，也不是集合的祖先。
        // 祖先豁免是必需的：macOS 上 `/var → /private/var` 会把工作区的祖先
        // `/private/var` 塞进解析链（见 isAncestorOfWorkingDirs）。
        const escaped = chain.find(
          (p) => !this.isWithinWorkingDirectories(p) && !this.isAncestorOfWorkingDirs(p),
        );
        if (escaped) {
          return {
            allowed: false,
            reason: `symlink 逃逸检测: ${filePath} → ${escaped} (解析链指向工作区外)`,
            needsConfirmation: true,
            resolvedPath: realPath,
          };
        }
      }
    }

    // 5. 敏感文件检测（大小写归一化比较，防 .ENV / .Pem 绕过）
    //
    // ⚠️ 必须排在下面的工作目录边界检查**之前**：边界检查收紧到「读也查」以后，
    // 工作区外的 `.env` / `*.pem` 若先落到边界分支，就变成 needsConfirmation
    // （交互能点允许、无头直接拒）—— 那是把「硬 deny」降级成「可放行」，属安全回退。
    // 凭证类目标永远走硬 deny，不给当轮话术留口子。
    //
    // SEC-AUDIT-2026-07-19 P2：命中即**硬 deny**（needsConfirmation: false），
    // 对齐 CC 推荐的 `deny Read(.env / *.pem / *.key)` 强度。
    //
    // 为什么从"需确认"收紧到"拒绝"：凭证文件被读走是**不可撤销**的损害，而弹窗确认
    // 恰恰是最容易被点穿的一环——模型给出的理由往往看着合理（"我需要看下 .env 里的
    // 数据库配置来修这个 bug"），用户在连续若干次确认后极易习惯性放行。对这类
    // 「一旦泄露无法回收」的目标，正确的默认值是不给这个选择。
    //
    // 逃生舱：确实需要访问时，在 settings.json 的 permissions.allow 里显式写
    // `Read(.env)` 这类规则——那是用户**离开对话、在配置文件里**做的决定，
    // 不受当轮对话的话术影响。见 checker.ts Step 4 的 allow 前置检查。
    if (matchesSensitivePath(realPath, realPathLower)) {
      return {
        allowed: false,
        reason: `敏感文件（凭证类，默认拒绝）: ${realPath}`,
        needsConfirmation: false,
        resolvedPath: realPath,
        sensitiveFile: true,
      };
    }

    // 6. 工作目录边界检查（读也查，对齐 Claude Code）
    //
    // 用工作目录集合（工作区 ∪ 白名单）而不是工作区：--add-dir / settings.allowedDirectories
    // 是用户显式授权的目录，语义与 Claude Code 的 additional working directories 一致
    // （可读**也可编辑**）。
    //
    // 读操作也查：CC 对工作目录外的 Read 要确认，sid-code 此前一律 allow ——
    // 「读通常安全」这个假设并不成立（区外可能是他人代码、系统配置、凭据）。
    // 返回 needsConfirmation 而不是硬 deny：交互模式下用户可以当轮允许，
    // 无头模式（-p / maxTurns>0）按既有规则降级为 deny 并把成因写进 reason。
    // 需要长期放行时配 allow 规则（如 `Read(/data/**)`）或把目录加进 --add-dir。
    if (!this.isWithinWorkingDirectories(realPath)) {
      return {
        allowed: false,
        reason:
          operation === "write"
            ? `写入路径在工作区外: ${realPath}`
            : `读取路径在工作区外: ${realPath}`,
        needsConfirmation: true,
        resolvedPath: realPath,
        outsideWorkingDirs: true,
      };
    }

    return { allowed: true, resolvedPath: realPath };
  }

  /**
   * P1-1：路径是否命中敏感文件硬 deny。grep / read_many 列举过滤与 Step 4 共用。
   * 目录形态（`~/.ssh` 无尾斜杠）也认——`/\.ssh\//` 否则会漏掉把搜索根指到密钥目录。
   */
  isSensitivePath(filePath: string): boolean {
    const realPath = this.resolveRealPath(filePath);
    const realPathLower = normalizeCaseForComparison(realPath);
    return matchesSensitivePath(realPath, realPathLower);
  }

  /**
   * 解析 symlink 到真实路径
   * 文件不存在时沿目录树向上查找最近的存在路径做 realpath，再拼接剩余部分
   */
  resolveRealPath(filePath: string): string {
    const resolved = path.resolve(filePath);
    try {
      // 文件存在，直接 realpath
      if (fs.existsSync(resolved)) {
        return fs.realpathSync(resolved);
      }
      // 文件不存在（新文件），向上查找最近存在的目录
      let current = path.dirname(resolved);
      const remaining = [path.basename(resolved)];
      while (current !== path.dirname(current)) {
        if (fs.existsSync(current)) {
          const realBase = fs.realpathSync(current);
          return path.join(realBase, ...remaining);
        }
        remaining.unshift(path.basename(current));
        current = path.dirname(current);
      }
      return resolved;
    } catch {
      return resolved;
    }
  }

  /**
   * 收集从原始路径到真实路径的完整解析链（对标 claude-code getPathsForPermissionCheck）。
   *
   * 逐段（path segment）向下走，每遇到一个 symlink 就把它的目标也纳入待检查集合，
   * 这样即使中间某一级目录是 symlink 指向工作区外，也能被捕获——
   * 而不是只看最终 realpath（最终 realpath 可能仍落在工作区内，掩盖了中间逃逸）。
   *
   * 返回去重后的绝对路径数组，至少包含原始 resolve 路径与最终 realpath。
   */
  getAllResolvedPaths(filePath: string): string[] {
    const resolved = path.resolve(filePath);
    const paths = new Set<string>([resolved]);

    try {
      // 沿路径逐段下行，记录每一级的真实路径（含中间 symlink 目标）
      const segments = resolved.split(path.sep).filter(Boolean);
      let current = path.isAbsolute(resolved) ? path.sep : "";
      for (const seg of segments) {
        current = current === path.sep ? path.sep + seg : path.join(current, seg);
        if (!fs.existsSync(current)) {
          // 当前级不存在（新文件/新目录），记录后停止下探
          paths.add(current);
          break;
        }
        try {
          const lst = fs.lstatSync(current);
          if (lst.isSymbolicLink()) {
            // 记录 symlink 自身与其解析目标
            const target = fs.realpathSync(current);
            paths.add(target);
            // 后续段基于解析目标继续拼接，使链条延续
            current = target;
          }
        } catch {
          // 单级解析失败不致命，继续
        }
      }
    } catch {
      // 解析整体失败，回退到最终 realpath
    }

    // 始终纳入最终 realpath（兜底）
    paths.add(this.resolveRealPath(filePath));
    return Array.from(paths);
  }

  /**
   * 检查路径是否在工作区内（大小写归一化比较，防大小写不敏感文件系统绕过）。
   *
   * 同时认 realpath 形态与 `path.resolve` 原形态：二者是同一物理目录的两种写法
   * （macOS `/var → /private/var`），只认其中一种会让另一种写法的路径被误判成区外。
   * 详见 AllowedDirEntry 的注释。
   */
  isWithinWorkspace(resolvedPath: string): boolean {
    return this.isWithinWorkspaceLower(normalizeCaseForComparison(resolvedPath));
  }

  /** isWithinWorkspace 的内部实现：入参已是小写形态，避免重复归一化 */
  private isWithinWorkspaceLower(lower: string): boolean {
    return (
      isPathWithinDir(lower, this.workspacePathLower) ||
      isPathWithinDir(lower, this.workspaceResolvedLower)
    );
  }

  /**
   * p 是否是某个工作目录（工作区或白名单项）的祖先（或它本身）。
   *
   * 为什么逃逸检测需要这条豁免：路径解析链里会出现**系统别名的真实目标**。
   * macOS 上 `/var → /private/var`，用户写的 `/var/…/ws/a.ts` 的链上有 `/private/var`；
   * 而工作区是 `/private/var/…/ws`，于是 `/private/var` 是工作区的**祖先**，
   * 必然不在工作区「内部」。把它判成逃逸是误报 —— 向上走到祖先并没有越界，
   * 最终目标仍然受第 2 步（白名单）/ 第 5 步（工作目录边界）约束。
   *
   * 不豁免会怎样：入口条件一旦认了别名写法（见 AllowedDirEntry），
   * 凡是 tmpdir（`/var/folders/…`）下的工作区，读写一律被判「symlink 逃逸」。
   */
  private isAncestorOfWorkingDirs(p: string): boolean {
    const lower = normalizeCaseForComparison(p);
    if (isPathWithinDir(this.workspacePathLower, lower)) return true;
    if (isPathWithinDir(this.workspaceResolvedLower, lower)) return true;
    return this.allowedDirectories.some(
      (dir) =>
        isPathWithinDir(normalizeCaseForComparison(dir.real), lower) ||
        isPathWithinDir(normalizeCaseForComparison(dir.resolved), lower),
    );
  }

  /**
   * 检查路径是否落在「工作目录集合」内：工作区 ∪ 白名单目录。
   *
   * 白名单（`--add-dir` / `/add-dir` / settings.allowedDirectories）是**追加**语义，
   * 不是替换：启动目录永远在集合里，和白名单一起构成用户可读写的工作目录集合
   * （对标 claude-code filesystem.ts 的 allWorkingDirectories = cwd ∪ additionalWorkingDirectories）。
   *
   * 与 isWithinWorkspace 的区别只在「白名单算不算工作目录」；两者共用同一个前缀判定，
   * 走同一套大小写归一化、根目录特判与双形态比较。
   */
  isWithinWorkingDirectories(resolvedPath: string): boolean {
    const lower = normalizeCaseForComparison(resolvedPath);
    if (this.isWithinWorkspaceLower(lower)) return true;
    return this.allowedDirectories.some(
      (dir) =>
        isPathWithinDir(lower, normalizeCaseForComparison(dir.real)) ||
        isPathWithinDir(lower, normalizeCaseForComparison(dir.resolved)),
    );
  }

  /** 获取工作区路径（已 realpath 归一化）。命令层 /add-dir --list 用它展示完整集合。 */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  // ── G25：运行时动态增删目录白名单（对标 claude-code /add-dir 扩展工作目录）──
  //
  // 构造时 allowedDirectories 一次性归一化后固定，无运行时入口。下列方法让 /add-dir
  // 这类"用户主动交互授权"能在会话内扩展白名单。归一化口径与构造函数完全一致
  // （real 形态 + resolved 形态，见 AllowedDirEntry），去重按 real 形态防重复 push。

  /** 归一化单个目录路径（与构造函数口径一致） */
  private normalizeDirEntry(dir: string): AllowedDirEntry {
    const resolved = path.resolve(dir);
    try {
      return { real: fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved, resolved };
    } catch {
      return { real: resolved, resolved };
    }
  }

  /**
   * 运行时新增一个允许访问的目录（去重）。
   * 归一化后若已在白名单则不重复添加。
   */
  addAllowedDirectory(dir: string): void {
    const entry = this.normalizeDirEntry(dir);
    if (!this.allowedDirectories.some((d) => d.real === entry.real)) {
      this.allowedDirectories.push(entry);
    }
  }

  /**
   * 运行时移除一个允许访问的目录。
   * @returns 是否命中并移除（未找到返回 false）
   */
  removeAllowedDirectory(dir: string): boolean {
    const entry = this.normalizeDirEntry(dir);
    // 两种形态任一命中即移除：用户可能用别名写法（/var/…）去移除一个按真实路径
    // （/private/var/…）登记的目录，反之亦然。
    const idx = this.allowedDirectories.findIndex(
      (d) => d.real === entry.real || d.resolved === entry.resolved,
    );
    if (idx === -1) return false;
    this.allowedDirectories.splice(idx, 1);
    return true;
  }

  /** 获取当前允许目录白名单（返回 realpath 形态副本，防外部篡改内部数组） */
  getAllowedDirectories(): string[] {
    return this.allowedDirectories.map((d) => d.real);
  }
}
