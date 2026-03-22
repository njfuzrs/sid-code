/**
 * 路径验证器
 * 集中处理：symlink 解析 + 工作区边界检查 + 系统目录保护 + 敏感文件检测
 * 替代 checker.ts 中分散的 checkPathSecurity / checkDirectoryAccess 逻辑
 */

import * as path from "node:path";
import * as fs from "node:fs";

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
