/**
 * Read 工具 - 读取文件内容
 * 支持行偏移和限制，用于读取大文件的部分内容
 * 读取后会记录到 FileStateCache，供 Edit 工具校验
 *
 * 对标 CC FileReadTool 的稳定性保护：
 * - 大文件大小上限（防 OOM）
 * - 二进制文件检测（防垃圾灌入上下文）
 * - 目录/设备文件拦截（防卡死/未定义行为）
 * - AbortSignal 全链路传递
 * - BOM/CRLF 规范化
 * - 空文件明确提示
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult, PermissionResult, ToolUseContext } from "./types.ts";
import type { FileStateCache } from "./file-state-cache.ts";
import type { FileReadTracker } from "./file-read-tracker.ts";
import { statSync } from "fs";
import { extname } from "path";
import { getLogger } from "../debug/logger.ts";
import { normalizeToolPath, formatPathNotFoundError } from "./path-utils.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

/** 未指定 limit 时的默认最大行数，防止超大文件撑爆上下文 */
const DEFAULT_MAX_LINES = 2000;

/** 文件大小上限（字节）：超过此值拒绝全量读取，要求指定 offset/limit */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * 设备文件黑名单：会导致无限输出或阻塞读取的设备路径。
 * 对标 CC BLOCKED_DEVICE_PATHS。
 */
const BLOCKED_DEVICE_PATHS = new Set([
  // 无限输出 — 永远不会 EOF
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
  // 阻塞等待输入
  "/dev/stdin",
  "/dev/tty",
  "/dev/console",
  // 无意义读取
  "/dev/stdout",
  "/dev/stderr",
  // stdio 的 fd 别名
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2",
]);

/**
 * 已知二进制文件扩展名集合。
 * 读取这些文件会产生乱码，浪费上下文 token。
 */
const BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".obj", ".o", ".a", ".lib",
  ".class", ".jar", ".war", ".ear",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".zst",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".tiff", ".tif", ".webp",
  ".mp3", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".mkv", ".wav", ".flac", ".ogg", ".m4a",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pyc", ".pyo", ".wasm",
  ".sqlite", ".db", ".sqlite3",
  ".DS_Store", ".ico",
]);

/** 检查路径是否为会阻塞/无限输出的设备文件 */
function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true;
  // /proc/self/fd/0-2 和 /proc/<pid>/fd/0-2 是 Linux 下 stdio 别名
  if (
    filePath.startsWith("/proc/") &&
    (filePath.endsWith("/fd/0") ||
      filePath.endsWith("/fd/1") ||
      filePath.endsWith("/fd/2"))
  ) {
    return true;
  }
  return false;
}

/** 检查文件扩展名是否为已知二进制格式 */
function hasBinaryExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * 检查缓冲区是否包含二进制内容（null 字节或高比例不可打印字符）
 * 仅检查前 8192 字节
 */
function isBinaryContent(buffer: Buffer): boolean {
  const checkSize = Math.min(buffer.length, 8192);
  let nonPrintable = 0;

  for (let i = 0; i < checkSize; i++) {
    const byte = buffer[i]!;
    // null 字节是二进制的强信号
    if (byte === 0) return true;
    // 统计非可打印、非空白字节
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      nonPrintable++;
    }
  }

  // 超过 10% 不可打印字符 → 大概率是二进制
  return checkSize > 0 && nonPrintable / checkSize > 0.1;
}

/** Read 工具输入 schema —— 运行时校验 + JSON Schema 生成的唯一真相源 */
const readSchema = lazySchema(() =>
  z.object({
    file_path: z.string().describe("要读取的文件的绝对路径"),
    offset: z.number().optional().describe("起始行号（从 1 开始），默认为 1"),
    limit: z.number().optional().describe(`读取的最大行数，默认 ${DEFAULT_MAX_LINES} 行`),
  }),
);

export class ReadTool implements Tool {
  private stateCache: FileStateCache | null;
  private tracker: FileReadTracker | null;

  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = readSchema();

  /**
   * 构造函数兼容两种 tracker 类型：
   * - FileReadTracker（旧版，用于 createStatefulTools 工厂和测试）
   * - FileStateCache（新版，LRU + 内容比对）
   *
   * 通过鸭子类型判断：FileStateCache 有 set() 方法，FileReadTracker 有 markAsRead() 方法。
   */
  constructor(trackerOrCache?: FileReadTracker | FileStateCache) {
    if (!trackerOrCache) {
      this.stateCache = null;
      this.tracker = null;
    } else if ("set" in trackerOrCache && typeof trackerOrCache.set === "function") {
      // FileStateCache
      this.stateCache = trackerOrCache as FileStateCache;
      this.tracker = null;
    } else {
      // FileReadTracker
      this.tracker = trackerOrCache as FileReadTracker;
      this.stateCache = null;
    }
  }

  readOnly(): boolean {
    return true;
  }

  /** 只读工具：无权限意见，交给权限系统决定 */
  async checkPermissions(_input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: "passthrough" };
  }

  name(): string {
    return "read";
  }

  description(): string {
    return "读取文件内容。支持指定行偏移和限制来读取大文件的部分内容。默认最多读取 2000 行，超出时会提示如何继续读取。";
  }

  usageGuide(): string {
    return `- 使用 read 而不是 bash cat/head/tail 来读取文件
- 默认最多读取 2000 行，超出时输出末尾会有截断提示
- 对于大文件，使用 offset 和 limit 参数只读取需要的部分
- 修改文件前必须先用 read 读取，确保了解当前内容
- file_path 必须是绝对路径
- 不支持读取二进制文件（如图片、压缩包等），请使用其他工具
- 超过 10MB 的文件需要指定 offset/limit 分段读取`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(readSchema()) as Record<string, unknown>;
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as { file_path: string; offset?: number; limit?: number };

    if (!params.file_path) {
      return { output: "错误: 缺少 file_path 参数", isError: true };
    }

    // P0: AbortSignal 检查 — 在任何 I/O 前先判断是否已中止
    if (signal?.aborted) {
      return { output: "操作已取消", isError: true };
    }

    let filePath: string;
    try {
      filePath = normalizeToolPath(params.file_path);
    } catch (err: any) {
      return { output: `路径无效: ${err.message}`, isError: true };
    }

    // P1: 设备文件拦截 — 防止卡死进程
    if (isBlockedDevicePath(filePath)) {
      return {
        output: `错误: 无法读取 '${filePath}': 该设备文件会阻塞进程或产生无限输出。`,
        isError: true,
      };
    }

    // P1: 二进制扩展名检测 — 防止垃圾灌入上下文
    if (hasBinaryExtension(filePath)) {
      const ext = extname(filePath).toLowerCase();
      return {
        output: `错误: 无法读取二进制文件 (${ext})。请使用适当的工具处理二进制文件。`,
        isError: true,
      };
    }

    log.info("TOOL", `▶ 读取 ${filePath} offset=${params.offset ?? 1} limit=${params.limit ?? DEFAULT_MAX_LINES}`);

    try {
      // P1: 目录检查 + P0: 大文件保护 — 在全量读取前用 stat 拦截
      let fileSize: number;
      try {
        const stat = statSync(filePath);
        if (stat.isDirectory()) {
          return {
            output: `错误: '${filePath}' 是一个目录，不是文件。请使用 ls 工具列出目录内容。`,
            isError: true,
          };
        }
        fileSize = stat.size;
      } catch (err: any) {
        if (err.code === "ENOENT") {
          return { output: formatPathNotFoundError(filePath), isError: true };
        }
        if (err.code === "EACCES") {
          return { output: `错误: 无权限读取文件: ${filePath}`, isError: true };
        }
        return { output: `读取文件失败: ${err.message}`, isError: true };
      }

      // P0: 大文件保护 — 超过 10MB 拒绝全量读取
      if (fileSize > MAX_FILE_SIZE_BYTES && !params.offset && !params.limit) {
        const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
        return {
          output: `错误: 文件过大 (${sizeMB} MB，超过 10 MB 上限)。请使用 offset 和 limit 参数分段读取，或使用 grep 搜索特定内容。`,
          isError: true,
        };
      }

      // P0: AbortSignal 再次检查 — stat 后、读取前
      if (signal?.aborted) {
        return { output: "操作已取消", isError: true };
      }

      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (!exists) {
        return { output: formatPathNotFoundError(filePath), isError: true };
      }

      // 读取文件内容
      const content = await file.text();

      // P1: 二进制内容检测 — 扩展名未拦截但内容是二进制的情况
      const contentBuffer = Buffer.from(content.slice(0, 8192));
      if (contentBuffer.length > 0 && isBinaryContent(contentBuffer)) {
        return {
          output: `错误: 文件内容包含二进制数据，无法以文本形式读取: ${filePath}`,
          isError: true,
        };
      }

      // P2: BOM 剥离
      let text = content;
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }

      const lines = text.split("\n");
      const totalLines = lines.length;

      // 处理偏移和限制（未指定 limit 时应用默认上限）
      const offset = Math.max(1, params.offset || 1);
      const startIdx = offset - 1;
      const maxLines = params.limit ?? DEFAULT_MAX_LINES;
      const endIdx = Math.min(startIdx + maxLines, totalLines);
      const selectedLines = lines.slice(startIdx, endIdx);
      const isTruncated = endIdx < totalLines;

      // P2: CRLF → LF 规范化
      const normalizedLines = selectedLines.map(line =>
        line.endsWith("\r") ? line.slice(0, -1) : line
      );

      // 记录文件已被读取
      const mtime = statSync(filePath).mtimeMs;
      if (this.stateCache) {
        const isPartialView = isTruncated || startIdx > 0;
        this.stateCache.set(filePath, {
          content: text,
          mtime,
          offset: startIdx > 0 ? offset : undefined,
          limit: params.limit,
          isPartialView,
        });
      } else if (this.tracker) {
        this.tracker.markAsRead(filePath, mtime);
      }

      // P3: 空文件提示
      if (totalLines === 0 || (totalLines === 1 && normalizedLines[0] === "")) {
        return { output: `[系统提示: 文件 ${filePath} 存在但内容为空。]` };
      }

      // 格式化输出（带行号，使用 tab 分隔符对齐 CC 的 cat -n 格式）
      let output = normalizedLines
        .map((line, idx) => `${startIdx + idx + 1}\t${line}`)
        .join("\n");

      // 截断提示：告知 LLM 当前显示的行范围和总行数
      if (isTruncated) {
        const shownStart = offset;
        const shownEnd = endIdx;
        const nextOffset = endIdx + 1;
        output += `\n\n[文件已截断：当前显示第 ${shownStart}-${shownEnd} 行，共 ${totalLines} 行。如需读取更多，请使用 offset=${nextOffset} 继续读取。]`;
      }

      log.info("TOOL", `✓ 读取 ${filePath} ${normalizedLines.length}行 ${isTruncated ? `(截断，共${totalLines}行)` : ""}`);

      return { output };
    } catch (err: any) {
      // 区分常见错误码
      if (err.code === "ENOENT") {
        return { output: formatPathNotFoundError(filePath), isError: true };
      }
      if (err.code === "EACCES" || err.code === "EPERM") {
        return { output: `错误: 无权限读取文件: ${filePath}`, isError: true };
      }
      return { output: `读取文件失败: ${err.message}`, isError: true };
    }
  }
}
