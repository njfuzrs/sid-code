/**
 * 临时目录多用户隔离（对标 claude-code 的 getClaudeTempDir）
 *
 * 痛点：此前各处直接 `join(tmpdir(), "sid-code", ...)`，在多用户共享主机（/tmp 全局可写）
 * 上会产生权限冲突与信息泄露——A 用户先创建 `/tmp/sid-code/`（默认 0777/0755），
 * B 用户的进程要么无法写入（owner 不同），要么能读到 A 的工具输出 / bundled skill 缓存。
 *
 * 方案（与 claude-code filesystem.ts:getClaudeTempDir 一致）：
 *   - Unix：目录名带 UID → `/tmp/sid-code-{uid}/`，按用户隔离；目录以 0o700 创建（仅 owner 可访问）
 *   - Windows：`tmpdir()` 本身已是 per-user（C:\Users\{user}\AppData\Local\Temp），无需 UID 后缀
 *   - 解析 base tmp 的 symlink（macOS `/tmp` → `/private/tmp`），保证与权限校验里的 realpath 比较口径一致
 *   - 支持 `SID_CODE_TMPDIR` 环境变量覆盖 base（沙箱 / 测试用）
 *
 * 目录层级：
 *   /tmp/sid-code-{uid}/                          ← 根（getSidTempDir）
 *   ├── bundled-skills/{nonce}/{skill}/           ← bundled skill 提取
 *   ├── sessions/{sessionId}/masked-outputs/      ← 工具输出遮罩落盘（getSessionTempDir）
 *   ├── sessions/{sessionId}/tool-outputs/        ← 工具输出存储
 *   └── ...                                       ← 其余临时文件
 */

import { tmpdir } from "node:os";
import { realpathSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** 平台是否 Windows */
function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * 用户专属的 sid-code 临时目录名。
 * - Unix：`sid-code-{uid}`，防止多用户共享 /tmp 时的权限冲突
 * - Windows：`sid-code`（tmpdir() 已经是 per-user，无需 UID）
 */
export function getSidTempDirName(): string {
  if (isWindows()) {
    return "sid-code";
  }
  // 用 UID 做 per-user 隔离；getuid 不可用时回退 0（极少见，如某些容器）
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `sid-code-${uid}`;
}

/** 记忆化结果：base tmp 的 realpath + 平台在进程内不变 */
let cachedTempDir: string | null = null;

/**
 * 返回 sid-code 临时目录根路径（symlink 已解析，不含尾部分隔符）。
 *
 * - base 优先取 `SID_CODE_TMPDIR` 环境变量，否则 Unix 用 `/tmp`、Windows 用 `tmpdir()`
 * - 解析 base 的 symlink（macOS `/tmp` → `/private/tmp`），与权限校验的 realpath 比较口径对齐
 * - 结果在进程内记忆化（输入在启动时已固定，系统 tmp 的 realpath 不会中途变化）
 */
export function getSidTempDir(): string {
  if (cachedTempDir) return cachedTempDir;

  const baseTmpDir = process.env.SID_CODE_TMPDIR || (isWindows() ? tmpdir() : "/tmp");

  // 解析 base tmp 的 symlink（macOS /tmp → /private/tmp），失败则用原路径
  let resolvedBase = baseTmpDir;
  try {
    resolvedBase = realpathSync(baseTmpDir);
  } catch {
    // realpath 失败（base 尚不存在等）→ 退回原路径，后续 mkdir 会补建
  }

  cachedTempDir = join(resolvedBase, getSidTempDirName());
  return cachedTempDir;
}

/**
 * 确保 sid-code 临时根目录存在，以 0o700（仅 owner）创建并返回其路径。
 * 多用户共享 /tmp 时，0o700 防止他人读到本用户的工具输出 / 缓存。
 */
export function ensureSidTempDir(): string {
  const dir = getSidTempDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * 会话级临时目录：`{root}/sessions/{sessionId}/{subdir?}`，以 0o700 创建并返回。
 * 不同会话互不串扰；subdir 用于区分用途（masked-outputs / tool-outputs 等）。
 *
 * @param sessionId 会话 ID;未提供时用 "default"
 * @param subdir    可选子目录(用途名)
 */
export function ensureSessionTempDir(sessionId?: string, subdir?: string): string {
  const parts = [getSidTempDir(), "sessions", sessionId ?? "default"];
  if (subdir) parts.push(subdir);
  const dir = join(...parts);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * 在 sid-code 临时根目录下创建并返回一个子目录(以 0o700)。
 * 用于 bundled-skills 等非会话级临时用途。
 */
export function ensureSidTempSubdir(...segments: string[]): string {
  const dir = join(getSidTempDir(), ...segments);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** 返回 sid-code 临时根目录下某路径(不创建,仅拼接)。带尾部分隔符版本见调用方需要。 */
export function sidTempPath(...segments: string[]): string {
  return join(getSidTempDir(), ...segments);
}

/** 仅测试用：清除记忆化缓存(改 env 后重新解析) */
export function __resetSidTempDirCache(): void {
  cachedTempDir = null;
}
