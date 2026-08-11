/**
 * 路径验证器
 * 集中处理：symlink 解析 + 工作区边界检查 + 系统目录保护 + 敏感文件检测
 * 替代 checker.ts 中分散的 checkPathSecurity / checkDirectoryAccess 逻辑
 *
 * 纵深防御（对标 claude-code filesystem.ts / pathValidation.ts）：
 *   Unicode 净化 → 大小写归一化 → Windows 绕过 → UNC 拦截 → 三点路径 →
 *   目录黑白名单 → 系统目录 → symlink 多路径链逃逸 → 工作区边界 → 敏感文件
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { hasDangerousUnicode } from "../utils/sanitization.ts";

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

/** 系统目录保护（写入拦截）— 包含 macOS /private 前缀 */
const PROTECTED_WRITE_DIRS = [
  "/etc/", "/usr/", "/bin/", "/sbin/", "/boot/",
  "/proc/", "/sys/", "/dev/", "/var/log/",
  "/System/", "/Library/",
  "/private/etc/", "/private/var/log/",
];

/** 系统目录保护（读取拦截）— 包含 macOS /private 前缀 */
const PROTECTED_READ_DIRS = ["/proc/", "/sys/", "/dev/"];

/** 敏感文件模式 */
const SENSITIVE_FILES = [
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

export class PathValidator {
  private workspacePath: string;
  /** 工作区路径的归一化（全小写）形式，供大小写不敏感文件系统比较使用 */
  private workspacePathLower: string;
  private allowedDirectories: string[];
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
    this.allowedDirectories = allowedDirectories.map(d => {
      const r = path.resolve(d);
      try { return fs.existsSync(r) ? fs.realpathSync(r) : r; } catch { return r; }
    });
    this.blockedDirectories = blockedDirectories.map(d => {
      const r = path.resolve(d);
      try { return fs.existsSync(r) ? fs.realpathSync(r) : r; } catch { return r; }
    });
  }

  /**
   * 验证文件路径访问权限
   * 综合检查：Unicode → Windows 绕过 → UNC → 三点路径 → 目录黑白名单
   *   → symlink 多路径链逃逸 → 系统目录 → 工作区边界 → 敏感文件
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
      if (realPathLower.startsWith(blockedLower + "/") || realPathLower === blockedLower) {
        return {
          allowed: false,
          reason: `目录被禁止访问: ${blocked}`,
          resolvedPath: realPath,
        };
      }
    }

    // 2. 目录白名单（如果配置了，大小写归一化比较）
    if (this.allowedDirectories.length > 0) {
      const inAllowed = this.allowedDirectories.some(dir => {
        const dirLower = normalizeCaseForComparison(dir);
        return realPathLower.startsWith(dirLower + "/") || realPathLower === dirLower;
      });
      if (!inAllowed) {
        return {
          allowed: false,
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

    // 4. symlink 多路径链逃逸检测：原始路径在工作区内，但解析链上任一环逃逸到工作区外
    //    （对标 claude-code getPathsForPermissionCheck —— 不止检查最终 realpath，
    //     还要检查从原始路径到 realpath 的每一个中间解析环节，
    //     防止 workdir/safe → symlink → /etc/passwd 这种中间环节逃逸）
    if (resolved !== realPath) {
      const originalInWorkspace = this.isWithinWorkspace(resolved);
      if (originalInWorkspace) {
        const chain = this.getAllResolvedPaths(filePath);
        const escaped = chain.find(p => !this.isWithinWorkspace(p));
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

    // 5. 工作区边界检查（仅写操作）
    if (operation === "write" && !this.isWithinWorkspace(realPath)) {
      return {
        allowed: false,
        reason: `写入路径在工作区外: ${realPath}`,
        needsConfirmation: true,
        resolvedPath: realPath,
      };
    }

    // 6. 敏感文件检测（大小写归一化比较，防 .ENV / .Pem 绕过）
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
    for (const pattern of SENSITIVE_FILES) {
      // 不区分大小写的正则（带 i flag）直接用原路径；其余用归一化路径兜底大小写绕过
      const target = pattern.flags.includes("i") ? realPath : realPathLower;
      const fallback = pattern.flags.includes("i") ? null : realPath;
      if (pattern.test(target) || (fallback !== null && pattern.test(fallback))) {
        return {
          allowed: false,
          reason: `敏感文件（凭证类，默认拒绝）: ${realPath}`,
          needsConfirmation: false,
          resolvedPath: realPath,
          sensitiveFile: true,
        };
      }
    }

    return { allowed: true, resolvedPath: realPath };
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

  /** 检查路径是否在工作区内（大小写归一化比较，防大小写不敏感文件系统绕过） */
  isWithinWorkspace(resolvedPath: string): boolean {
    const lower = normalizeCaseForComparison(resolvedPath);
    return lower === this.workspacePathLower ||
      lower.startsWith(this.workspacePathLower + "/");
  }

  // ── G25：运行时动态增删目录白名单（对标 claude-code /add-dir 扩展工作目录）──
  //
  // 构造时 allowedDirectories 一次性归一化后固定，无运行时入口。下列方法让 /add-dir
  // 这类"用户主动交互授权"能在会话内扩展白名单。归一化口径与构造函数完全一致
  // （path.resolve → realpathSync，失败回退 resolve），确保与 validateAccess 的
  // startsWith 比较一致；去重防重复 push。

  /** 归一化单个目录路径（与构造函数口径一致） */
  private normalizeDir(dir: string): string {
    const r = path.resolve(dir);
    try {
      return fs.existsSync(r) ? fs.realpathSync(r) : r;
    } catch {
      return r;
    }
  }

  /**
   * 运行时新增一个允许访问的目录（去重）。
   * 归一化后若已在白名单则不重复添加。
   */
  addAllowedDirectory(dir: string): void {
    const normalized = this.normalizeDir(dir);
    if (!this.allowedDirectories.includes(normalized)) {
      this.allowedDirectories.push(normalized);
    }
  }

  /**
   * 运行时移除一个允许访问的目录。
   * @returns 是否命中并移除（未找到返回 false）
   */
  removeAllowedDirectory(dir: string): boolean {
    const normalized = this.normalizeDir(dir);
    const idx = this.allowedDirectories.indexOf(normalized);
    if (idx === -1) return false;
    this.allowedDirectories.splice(idx, 1);
    return true;
  }

  /** 获取当前允许目录白名单（返回副本，防外部篡改内部数组） */
  getAllowedDirectories(): string[] {
    return [...this.allowedDirectories];
  }
}
