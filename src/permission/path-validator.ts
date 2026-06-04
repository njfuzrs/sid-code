/**
 * 路径验证器
 * 集中处理：symlink 解析 + 工作区边界检查 + 系统目录保护 + 敏感文件检测
 * 替代 checker.ts 中分散的 checkPathSecurity / checkDirectoryAccess 逻辑
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
  /\.kube\/config/,
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
  { pattern: /^\\\\\?\\/, desc: "长路径前缀 (\\\\?\\)" },
  // 尾随点/空格：要求前面有真实文件名字符，避免误伤 "." / ".." 目录引用
  { pattern: /[^.\\/ ][. ]+$/, desc: "尾随点/空格（Windows 静默去除）" },
  { pattern: /(^|[\\/])(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i, desc: "DOS 设备名" },
];

/** 检测路径是否命中 Windows 绕过模式，返回命中的描述（未命中返回 null） */
function detectWindowsBypass(filePath: string): string | null {
  for (const { pattern, desc } of WINDOWS_BYPASS_PATTERNS) {
    if (pattern.test(filePath)) return desc;
  }
  return null;
}

export class PathValidator {
  private workspacePath: string;
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
   * 综合检查：目录黑白名单 → symlink 解析 → 工作区边界 → 系统目录 → 敏感文件
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

    // 1. 目录黑名单（最高优先级）
    for (const blocked of this.blockedDirectories) {
      if (realPath.startsWith(blocked + "/") || realPath === blocked) {
        return {
          allowed: false,
          reason: `目录被禁止访问: ${blocked}`,
          resolvedPath: realPath,
        };
      }
    }

    // 2. 目录白名单（如果配置了）
    if (this.allowedDirectories.length > 0) {
      const inAllowed = this.allowedDirectories.some(dir =>
        realPath.startsWith(dir + "/") || realPath === dir
      );
      if (!inAllowed) {
        return {
          allowed: false,
          reason: "目录不在白名单中",
          resolvedPath: realPath,
        };
      }
    }

    // 3. 系统目录保护（优先于工作区边界，因为系统目录信息更具体）
    if (operation === "write") {
      for (const protectedDir of PROTECTED_WRITE_DIRS) {
        if (realPath.startsWith(protectedDir)) {
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
        if (realPath.startsWith(protectedDir)) {
          return {
            allowed: false,
            reason: `系统目录读取被拦截: ${realPath}`,
            needsConfirmation: true,
            resolvedPath: realPath,
          };
        }
      }
    }

    // 4. symlink 逃逸检测：原始路径在工作区内，但真实路径在工作区外
    if (resolved !== realPath) {
      const originalInWorkspace = this.isWithinWorkspace(resolved);
      const realInWorkspace = this.isWithinWorkspace(realPath);
      if (originalInWorkspace && !realInWorkspace) {
        return {
          allowed: false,
          reason: `symlink 逃逸检测: ${filePath} → ${realPath} (指向工作区外)`,
          needsConfirmation: true,
          resolvedPath: realPath,
        };
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

    // 6. 敏感文件检测
    for (const pattern of SENSITIVE_FILES) {
      if (pattern.test(realPath)) {
        return {
          allowed: false,
          reason: `敏感文件: ${realPath}`,
          needsConfirmation: true,
          resolvedPath: realPath,
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

  /** 检查路径是否在工作区内 */
  isWithinWorkspace(resolvedPath: string): boolean {
    return resolvedPath === this.workspacePath ||
      resolvedPath.startsWith(this.workspacePath + "/");
  }
}
