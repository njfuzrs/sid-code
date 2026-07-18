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

/** PDF 单次读取最大页数（对齐 CC PDF_MAX_PAGES_PER_READ=20）。*/
const PDF_MAX_PAGES_PER_READ = 20;
/** 不指定 pages 时允许直接整份读取的页数上限（对齐 CC PDF_AT_MENTION_INLINE_THRESHOLD=10）。*/
const PDF_INLINE_PAGE_THRESHOLD = 10;

/**
 * 估算 PDF 页数（无第三方库，扫描原始字节）。
 * 优先统计 `/Type /Page`（非 /Pages）对象数；回退到 `/Count N`。
 * 返回 null 表示无法可靠判定（不阻断，避免误伤加密/异形 PDF）。
 */
function estimatePdfPageCount(buffer: Buffer): number | null {
  // Buffer→latin1 字符串足以匹配 PDF 结构关键字（PDF 语法用 ASCII）
  const text = buffer.toString("latin1");
  // /Type /Page（后面不接 s，排除 /Pages 树节点）；容忍中间空白
  const pageMatches = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  if (pageMatches && pageMatches.length > 0) return pageMatches.length;
  // 回退：页树根的 /Count N（取最大值，防嵌套 /Kids 子树多个 /Count）
  const countMatches = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => parseInt(m[1], 10));
  if (countMatches.length > 0) return Math.max(...countMatches);
  return null;
}

/**
 * 解析 pages 参数（如 "1-5" / "3" / "2,4,7"），返回涉及的页码数量。
 * 解析失败返回 null（交由上层报格式错误）。
 */
function countRequestedPages(pages: string): number | null {
  const parts = pages.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  let total = 0;
  for (const part of parts) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = parseInt(range[1], 10);
      const end = parseInt(range[2], 10);
      if (start < 1 || end < start) return null;
      total += end - start + 1;
    } else if (/^\d+$/.test(part)) {
      if (parseInt(part, 10) < 1) return null;
      total += 1;
    } else {
      return null; // 非法片段
    }
  }
  return total;
}

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
 * G6：图片扩展名集合。这些文件此前被当二进制拒读，现改为以 vision 内容块返回，
 * 让支持视觉的模型能直接看图（截图、图表、UI 稿等）。
 */
const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
]);

/** 图片扩展名 → MIME 媒体类型 */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * G6：图片 base64 编码后的体积上限（约 3.75 MB 原始 → ~5MB base64）。
 * 对标 Anthropic API 单图 5MB 限制，超过则拒绝（提示用户压缩）。
 */
const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;

function isImageExtension(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function isPdfExtension(filePath: string): boolean {
  return extname(filePath).toLowerCase() === ".pdf";
}

function isNotebookExtension(filePath: string): boolean {
  return extname(filePath).toLowerCase() === ".ipynb";
}

/**
 * G6：把 Jupyter Notebook（.ipynb）渲染为带 cell id 的文本视图。
 *
 * 输出格式对齐 NotebookEdit 工具的定位约定（<cell id="..."> ... </cell>），
 * 让模型读完就能直接用 notebook_edit 按 id 编辑。code cell 附带输出（stdout/
 * 文本结果/错误），图片类输出以占位标注（不内联 base64，避免撑爆上下文）。
 */
function renderNotebook(raw: string): string {
  let nb: any;
  try {
    nb = JSON.parse(raw);
  } catch (err: any) {
    return `[错误: notebook JSON 解析失败: ${err.message}]`;
  }
  if (!Array.isArray(nb.cells)) {
    return "[错误: notebook 格式无效（缺少 cells 数组）]";
  }

  const joinSource = (source: unknown): string => {
    if (Array.isArray(source)) return source.join("");
    if (typeof source === "string") return source;
    return "";
  };

  const parts: string[] = [];
  const lang = nb.metadata?.kernelspec?.language || nb.metadata?.language_info?.name || "";
  parts.push(`[Jupyter Notebook: ${nb.cells.length} cells${lang ? `, kernel=${lang}` : ""}]`);

  nb.cells.forEach((cell: any, idx: number) => {
    const id = cell.id || cell.metadata?.id || String(idx);
    const type = cell.cell_type || "unknown";
    const src = joinSource(cell.source);
    parts.push(`\n<cell id="${id}" type="${type}">`);
    parts.push(src || "(空)");

    // code cell 的输出
    if (type === "code" && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
      const outLines: string[] = [];
      for (const out of cell.outputs) {
        switch (out.output_type) {
          case "stream":
            outLines.push(joinSource(out.text));
            break;
          case "execute_result":
          case "display_data": {
            const textData = out.data?.["text/plain"];
            if (textData) outLines.push(joinSource(textData));
            // 图片输出：仅标注，不内联 base64
            if (out.data?.["image/png"] || out.data?.["image/jpeg"]) {
              outLines.push("[图片输出，已省略 base64]");
            }
            break;
          }
          case "error":
            outLines.push(`[错误: ${out.ename}: ${out.evalue}]`);
            break;
        }
      }
      if (outLines.length > 0) {
        parts.push(`--- 输出 ---\n${outLines.join("\n")}`);
      }
    }
    parts.push(`</cell>`);
  });

  return parts.join("\n");
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
    pages: z.string().optional().describe("PDF 文件的页码范围（如 \"1-5\"、\"3\"、\"2,4,7\"），仅对 .pdf 生效。单次最多 20 页；PDF 超过 10 页时必须指定该参数，否则会报错要求分页"),
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

  /**
   * G14：观测输入回填——把 file_path 展开为绝对路径，供权限校验/hook 观测。
   * 执行输入不变（保持 prompt cache 前缀稳定）。read 是只读工具，回填让 deny 规则
   * 能正确命中 ~/相对路径 形态（否则规则只写绝对路径时会被绕过）。
   */
  backfillObservableInput(input: unknown): unknown | undefined {
    const filePath = (input as any)?.file_path;
    if (!filePath || typeof filePath !== "string") return undefined;
    try {
      const expanded = normalizeToolPath(filePath);
      if (expanded === filePath) return undefined;
      return { ...(input as any), file_path: expanded };
    } catch { return undefined; }
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
- 支持读取图片（png/jpg/jpeg/gif/webp）——以视觉内容块返回，可直接看图
- 支持读取 PDF（.pdf）——以文档块返回，可用 pages 参数提示关注页码
- 支持读取 Jupyter Notebook（.ipynb）——返回带 cell id 的结构，可配合 notebook_edit 编辑
- 仍不支持其它二进制文件（压缩包、可执行文件等）
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

    // G6：富媒体分支（图片/Notebook/PDF）——在二进制拒绝之前处理
    if (isImageExtension(filePath)) {
      return this.readImage(filePath);
    }
    if (isNotebookExtension(filePath)) {
      return this.readNotebook(filePath);
    }
    if (isPdfExtension(filePath)) {
      return this.readPdf(filePath, params as any);
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
        // 对标 claude-code：部分视图（分段/截断）不足以安全 edit，记录 isPartialView；
        // 完整读取时连内容一起记，供 edit 前的外部修改内容比对兜底（避免假误报）。
        const isPartialView = isTruncated || startIdx > 0;
        this.tracker.markAsRead(filePath, mtime, {
          isPartialView,
          content: isPartialView ? null : text,
        });
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

  /**
   * G6：读取图片文件 → base64 mediaBlock（vision 内容块）。
   * 支持 vision 的 provider（Anthropic）序列化时把图片喂给模型；不支持的
   * provider 忽略 mediaBlocks、只见文本摘要（优雅降级）。
   */
  private async readImage(filePath: string): Promise<ToolResult> {
    const log = getLogger();
    try {
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        return { output: `错误: '${filePath}' 是一个目录。`, isError: true };
      }
      if (stat.size > MAX_IMAGE_BYTES) {
        const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
        return {
          output: `错误: 图片过大 (${sizeMB} MB，超过 ${(MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(1)} MB 上限)。请压缩后再读取。`,
          isError: true,
        };
      }
      const ext = extname(filePath).toLowerCase();
      const mediaType = IMAGE_MEDIA_TYPES[ext] || "image/png";
      const buffer = await Bun.file(filePath).arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");

      log.info("TOOL", `✓ 读取图片 ${filePath} (${(stat.size / 1024).toFixed(0)} KB, ${mediaType})`);
      return {
        output: `[图片: ${filePath} (${mediaType}, ${(stat.size / 1024).toFixed(0)} KB)]`,
        mediaBlocks: [{ kind: "image", mediaType, data: base64 }],
      };
    } catch (err: any) {
      if (err.code === "ENOENT") return { output: formatPathNotFoundError(filePath), isError: true };
      return { output: `读取图片失败: ${err.message}`, isError: true };
    }
  }

  /**
   * G6：读取 Notebook（.ipynb）→ 带 cell id 的文本视图（供 notebook_edit 按 id 编辑）。
   */
  private async readNotebook(filePath: string): Promise<ToolResult> {
    const log = getLogger();
    try {
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        return { output: `错误: '${filePath}' 是一个目录。`, isError: true };
      }
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
        return { output: `错误: notebook 过大 (${sizeMB} MB)。`, isError: true };
      }
      const raw = await Bun.file(filePath).text();
      const rendered = renderNotebook(raw);

      // 记录已读（notebook 作为整体，非部分视图——供后续 notebook_edit 前的存在性判断）
      if (this.stateCache) {
        this.stateCache.set(filePath, { content: raw, mtime: stat.mtimeMs, isPartialView: false });
      } else if (this.tracker) {
        this.tracker.markAsRead(filePath, stat.mtimeMs, { isPartialView: false, content: raw });
      }

      log.info("TOOL", `✓ 读取 notebook ${filePath}`);
      return { output: rendered };
    } catch (err: any) {
      if (err.code === "ENOENT") return { output: formatPathNotFoundError(filePath), isError: true };
      return { output: `读取 notebook 失败: ${err.message}`, isError: true };
    }
  }

  /**
   * G6：读取 PDF → base64 document mediaBlock（Claude 原生支持 PDF 文档块）。
   *
   * 不在本地做 PDF 解析/分页（无 PDF 库依赖）——直接把整份 PDF 以 base64 document 块
   * 交给支持 PDF 的 provider（Anthropic）。pages 参数当前仅作提示透传给模型，不做本地裁剪。
   */
  private async readPdf(filePath: string, params: { pages?: string }): Promise<ToolResult> {
    const log = getLogger();
    try {
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        return { output: `错误: '${filePath}' 是一个目录。`, isError: true };
      }
      // PDF 走 document 块，Anthropic 限制约 32MB / 100 页；这里用文件大小上限兜底
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
        return {
          output: `错误: PDF 过大 (${sizeMB} MB，超过 ${(MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0)} MB 上限)。请拆分后再读取。`,
          isError: true,
        };
      }
      const buffer = Buffer.from(await Bun.file(filePath).arrayBuffer());

      // 页数门限校验（对齐 CC）：避免大 PDF 整份 base64 盲传撑爆上下文/超 provider 限制。
      const pageCount = estimatePdfPageCount(buffer);

      if (params.pages) {
        // 给了 pages：校验格式 + 请求页数不超单次上限
        const requested = countRequestedPages(params.pages);
        if (requested === null) {
          return {
            output: `错误: pages 参数格式非法 "${params.pages}"。支持 "1-5"、"3"、"2,4,7" 等格式。`,
            isError: true,
          };
        }
        if (requested > PDF_MAX_PAGES_PER_READ) {
          return {
            output: `错误: 单次最多读取 ${PDF_MAX_PAGES_PER_READ} 页，本次请求 ${requested} 页。请缩小 pages 范围分次读取。`,
            isError: true,
          };
        }
        if (pageCount !== null && requested > pageCount) {
          return {
            output: `错误: 请求页数 ${requested} 超过 PDF 实际页数 ${pageCount}。`,
            isError: true,
          };
        }
      } else if (pageCount !== null && pageCount > PDF_INLINE_PAGE_THRESHOLD) {
        // 未给 pages 且页数超阈值：拒绝盲传整份，要求显式分页
        return {
          output:
            `错误: PDF 共 ${pageCount} 页，超过不分页直读上限 (${PDF_INLINE_PAGE_THRESHOLD} 页)。` +
            `请用 pages 参数指定范围（如 "1-${PDF_MAX_PAGES_PER_READ}"），单次最多 ${PDF_MAX_PAGES_PER_READ} 页。`,
          isError: true,
        };
      }

      const base64 = buffer.toString("base64");
      const pageCountHint = pageCount !== null ? `，共 ${pageCount} 页` : "";
      const pagesHint = params.pages ? `，关注页码 ${params.pages}` : "";

      log.info("TOOL", `✓ 读取 PDF ${filePath} (${(stat.size / 1024).toFixed(0)} KB${pageCountHint})`);
      return {
        output: `[PDF 文档: ${filePath} (${(stat.size / 1024).toFixed(0)} KB${pageCountHint})${pagesHint}]`,
        mediaBlocks: [{ kind: "document", mediaType: "application/pdf", data: base64 }],
      };
    } catch (err: any) {
      if (err.code === "ENOENT") return { output: formatPathNotFoundError(filePath), isError: true };
      return { output: `读取 PDF 失败: ${err.message}`, isError: true };
    }
  }
}
