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

import type {
  LegacyTool as Tool,
  LegacyToolResult as ToolResult,
  PermissionResult,
  ToolUseContext,
} from "./types.ts";
import type { FileStateCache } from "./file-state-cache.ts";
import type { FileReadTracker } from "./file-read-tracker.ts";
import { statSync } from "fs";
import { extname } from "path";
import { getLogger } from "../debug/logger.ts";
import { normalizeToolPath, formatPathNotFoundError } from "./path-utils.ts";
import { pickPaths } from "./jit-affected-paths.ts";
import {
  detectBinaryContent,
  formatBinaryRejection,
  BINARY_CHECK_WINDOW,
} from "./binary-detect.ts";
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
  const parts = pages
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
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
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".obj",
  ".o",
  ".a",
  ".lib",
  ".class",
  ".jar",
  ".war",
  ".ear",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".zst",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".tiff",
  ".tif",
  ".webp",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".wmv",
  ".flv",
  ".mkv",
  ".wav",
  ".flac",
  ".ogg",
  ".m4a",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".pyc",
  ".pyo",
  ".wasm",
  ".sqlite",
  ".db",
  ".sqlite3",
  ".DS_Store",
  ".ico",
]);

/** 检查路径是否为会阻塞/无限输出的设备文件 */
function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true;
  // /proc/self/fd/0-2 和 /proc/<pid>/fd/0-2 是 Linux 下 stdio 别名
  if (
    filePath.startsWith("/proc/") &&
    (filePath.endsWith("/fd/0") || filePath.endsWith("/fd/1") || filePath.endsWith("/fd/2"))
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
// vision 支持的图片扩展名。范围严格对齐 Anthropic Messages API 官方支持的
// 四种格式（image/png、image/jpeg、image/gif、image/webp）。
// TIFF/BMP：Anthropic vision 明确不支持，加入只会触发 API 400（invalid media type），
// 故不纳入——如需读这类图片，应先本地转码为上述格式（P3-4 结论：不支持则明确不支持）。
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

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

// 二进制检测已收敛到 ./binary-detect.ts（原先 read.ts 与 read-many.ts 各抄一份
// 逐字节相同的实现，改一处漏一处）。判据不变，额外产出可定位的诊断信息。

/** Read 工具输入 schema —— 运行时校验 + JSON Schema 生成的唯一真相源 */
const readSchema = lazySchema(() =>
  z.object({
    file_path: z.string().describe("要读取的文件的绝对路径"),
    offset: z.number().optional().describe("起始行号（从 1 开始），默认为 1"),
    limit: z.number().optional().describe(`读取的最大行数，默认 ${DEFAULT_MAX_LINES} 行`),
    pages: z
      .string()
      .optional()
      .describe(
        'PDF 文件的页码范围（如 "1-5"、"3"、"2,4,7"），仅对 .pdf 生效。单次最多 20 页；PDF 超过 10 页时必须指定该参数，否则会报错要求分页',
      ),
  }),
);

/** 发现 4：单文件读取历史（一次读取的行窗口 + 是否整文件可覆盖），用于"重复窄读"引导。 */
interface ReadWindow {
  startLine: number; // 1-based 起始行
  endLine: number; // 含
  totalLines: number;
}

/**
 * 发现 4：重复读引导的标记前缀（唯一、便于下游精确剥离）。
 *
 * ★关键（防回归）：此提示是**元信息**,不是文件内容。它会被追加进 read 的 tool_result output,
 * 而 repeated-readonly-guard 用 (命令, output) 签名做"卡住"判定——提示里含每次自增的"第N次"计数,
 * 若不剥离会让相同区域的重复读每轮签名都不同 → guard 的 repeatCount 永远清零 → 反而**瘫痪**了
 * git-status 冻结死循环的止损阀(缺口B)。故 guard 捕获 read 输出做签名前,必须先剥离本前缀起的整段。
 * 用独特前缀(非泛用的"[提示:")避免误伤其它可能的方括号提示。
 */
export const READ_EFFICIENCY_HINT_MARK = "\n\n[读取效率提示: ";

/** 发现 4：从 read 输出里剥离效率提示段(供 loop-detection 等做内容签名前调用),无提示则原样返回。 */
export function stripReadEfficiencyHint(output: string): string {
  const idx = output.indexOf(READ_EFFICIENCY_HINT_MARK);
  return idx === -1 ? output : output.slice(0, idx);
}

/** 发现 4：触发"重复读"引导的最少读取次数（给模型两次定向复查的余地，第 3 次才提示）。 */
const REPEAT_READ_HINT_THRESHOLD = 3;
/** 发现 4：每个 file_path 最多保留的近期读窗口数（防无界增长）。 */
const READ_HISTORY_PER_FILE_CAP = 12;
/** 发现 4：读历史最多跟踪的文件数（LRU 粗粒度，防大会话内存膨胀）。 */
const READ_HISTORY_FILES_CAP = 64;

export class ReadTool implements Tool {
  private stateCache: FileStateCache | null;
  private tracker: FileReadTracker | null;
  /** 发现 4：file_path → 近期读窗口列表。纯效率引导用，不影响读取结果。 */
  private readHistory = new Map<string, ReadWindow[]>();

  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = readSchema();

  /** P2-9：JIT 上下文发现的路径自报（契约见 types.ts jitAffectedPaths） */
  jitAffectedPaths(input: unknown): string[] {
    return pickPaths(input, "file_path");
  }

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

  /**
   * 发现 4：记录本次读窗口并生成"重复窄读"非阻塞引导（不改读取结果，只在 output 末尾追加提示）。
   *
   * 背景：弱模型对大文件常做几十次 `limit=10~60` 的窄窗读、反复重读同一区域(实证单文件 33 次)。
   * read 是纯只读工具,重复读不报错、无引导,模型缺乏"停止重读"的外部信号 → 拉长步数 + 推高 token。
   *
   * 只做**非阻塞提示**,绝不拦截(read 是安全只读操作,拦截会误伤合法的定向复查),对齐记忆
   * `write-truncation-opt-triple-review` 里"回注通道只提醒不强制"的定调。触发两类提示:
   *   ① 重复读:同文件近期读 ≥ 阈值次且本次窗口与历史高度重叠 → 提示复用已读内容;
   *   ② 读太窄:文件行数 < 默认上限却传了小 limit → 提示可一次整读。
   * 返回追加到 output 的提示串(可为空)。
   */
  private recordReadAndBuildHint(
    filePath: string,
    win: ReadWindow,
    hadExplicitLimit: boolean,
  ): string {
    // 取本文件历史(在追加本次之前),用于判定重叠/重复
    const prior = this.readHistory.get(filePath) ?? [];

    // 与历史窗口的重叠比例(本次窗口有多少行此前已读过)
    const winLen = Math.max(1, win.endLine - win.startLine + 1);
    let maxOverlapRatio = 0;
    for (const p of prior) {
      const lo = Math.max(win.startLine, p.startLine);
      const hi = Math.min(win.endLine, p.endLine);
      if (hi >= lo) {
        maxOverlapRatio = Math.max(maxOverlapRatio, (hi - lo + 1) / winLen);
      }
    }

    // 追加本次窗口到历史(带每文件/文件数上限,LRU 粗回收)
    const updated = [...prior, win].slice(-READ_HISTORY_PER_FILE_CAP);
    this.readHistory.delete(filePath); // 删后重插 → 维持插入序,近用在尾
    this.readHistory.set(filePath, updated);
    if (this.readHistory.size > READ_HISTORY_FILES_CAP) {
      const oldest = this.readHistory.keys().next().value;
      if (oldest !== undefined) this.readHistory.delete(oldest);
    }

    const readCount = updated.length;
    const hints: string[] = [];

    // ① 重复窄读:读够多次 + 本次与历史高度重叠(>60%)
    if (readCount >= REPEAT_READ_HINT_THRESHOLD && maxOverlapRatio > 0.6) {
      const fitsInOneRead = win.totalLines <= DEFAULT_MAX_LINES;
      hints.push(
        `本会话已第 ${readCount} 次读取 ${filePath},且本次窗口与此前读过的区域高度重叠。` +
          (fitsInOneRead
            ? `该文件共 ${win.totalLines} 行(未超单次上限 ${DEFAULT_MAX_LINES}),建议一次性整读(不传 offset/limit)或直接复用已读内容,避免重复读推高上下文。`
            : `建议复用已读内容,或用 grep 定位后按需读,避免反复窄读同一区域。`),
      );
    } else if (
      // ② 读太窄:**首次**读一个不大的文件却传了小 limit(只在第 1 次提示,避免每次窄读都唠叨)
      readCount === 1 &&
      hadExplicitLimit &&
      win.totalLines <= DEFAULT_MAX_LINES &&
      winLen < win.totalLines &&
      winLen < 200
    ) {
      hints.push(
        `该文件共 ${win.totalLines} 行,未超单次读取上限 ${DEFAULT_MAX_LINES}。若需通览,可不传 limit 一次整读,省去多次分段。`,
      );
    }

    // 用独特标记前缀(READ_EFFICIENCY_HINT_MARK)包裹,便于 loop-detection 精确剥离,不污染内容签名。
    return hints.length ? `${READ_EFFICIENCY_HINT_MARK}${hints.join(" ")}]` : "";
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
    } catch {
      return undefined;
    }
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

    log.info(
      "TOOL",
      `▶ 读取 ${filePath} offset=${params.offset ?? 1} limit=${params.limit ?? DEFAULT_MAX_LINES}`,
    );

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

      // P1: 二进制内容检测 — 扩展名未拦截但内容是二进制的情况。
      // 判据不变，但报错要带上「首个可疑字节的偏移/行列 + 总数 + 修法」——旧版只说
      // 一句"包含二进制数据"，模型为定位单个 NUL 字节要连烧 5+ 次工具调用。
      const contentBuffer = Buffer.from(content.slice(0, BINARY_CHECK_WINDOW));
      if (contentBuffer.length > 0) {
        const detection = detectBinaryContent(contentBuffer);
        if (detection.isBinary) {
          return {
            output: formatBinaryRejection(filePath, detection, contentBuffer, fileSize),
            isError: true,
          };
        }
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
      const normalizedLines = selectedLines.map((line) =>
        line.endsWith("\r") ? line.slice(0, -1) : line,
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

        // 声明文件读取意图（并发冲突检测）
        if (this.tracker.sessionId && this.tracker.pid && this.tracker.cwd) {
          const { declareFileIntent } = await import("../session/file-intent.ts");
          declareFileIntent(
            this.tracker.sessionId,
            this.tracker.pid,
            this.tracker.cwd,
            filePath,
            "read",
          );
        }
      }

      // P3: 空文件提示
      if (totalLines === 0 || (totalLines === 1 && normalizedLines[0] === "")) {
        return { output: `[系统提示: 文件 ${filePath} 存在但内容为空。]` };
      }

      // 格式化输出（带行号，使用 tab 分隔符对齐 CC 的 cat -n 格式）
      let output = normalizedLines.map((line, idx) => `${startIdx + idx + 1}\t${line}`).join("\n");

      // 截断提示：告知 LLM 当前显示的行范围和总行数
      if (isTruncated) {
        const shownStart = offset;
        const shownEnd = endIdx;
        const nextOffset = endIdx + 1;
        output += `\n\n[文件已截断：当前显示第 ${shownStart}-${shownEnd} 行，共 ${totalLines} 行。如需读取更多，请使用 offset=${nextOffset} 继续读取。]`;
      }

      // 发现 4：记录读窗口 + 追加"重复窄读"非阻塞引导（失败不影响读取结果）。
      try {
        output += this.recordReadAndBuildHint(
          filePath,
          { startLine: offset, endLine: endIdx, totalLines },
          params.limit !== undefined,
        );
      } catch {
        /* 引导是锦上添花，绝不阻断读取 */
      }

      log.info(
        "TOOL",
        `✓ 读取 ${filePath} ${normalizedLines.length}行 ${isTruncated ? `(截断，共${totalLines}行)` : ""}`,
      );

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

      log.info(
        "TOOL",
        `✓ 读取图片 ${filePath} (${(stat.size / 1024).toFixed(0)} KB, ${mediaType})`,
      );
      return {
        output: `[图片: ${filePath} (${mediaType}, ${(stat.size / 1024).toFixed(0)} KB)]`,
        mediaBlocks: [{ kind: "image", mediaType, data: base64 }],
      };
    } catch (err: any) {
      if (err.code === "ENOENT")
        return { output: formatPathNotFoundError(filePath), isError: true };
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
      if (err.code === "ENOENT")
        return { output: formatPathNotFoundError(filePath), isError: true };
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

      log.info(
        "TOOL",
        `✓ 读取 PDF ${filePath} (${(stat.size / 1024).toFixed(0)} KB${pageCountHint})`,
      );
      return {
        output: `[PDF 文档: ${filePath} (${(stat.size / 1024).toFixed(0)} KB${pageCountHint})${pagesHint}]`,
        mediaBlocks: [{ kind: "document", mediaType: "application/pdf", data: base64 }],
      };
    } catch (err: any) {
      if (err.code === "ENOENT")
        return { output: formatPathNotFoundError(filePath), isError: true };
      return { output: `读取 PDF 失败: ${err.message}`, isError: true };
    }
  }
}
