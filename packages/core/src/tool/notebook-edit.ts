/**
 * G11: NotebookEdit 工具 — cell 级 Jupyter Notebook 编辑
 *
 * 对标 claude-code NotebookEditTool.ts:490，支持 replace / insert / delete 三种操作。
 * ipynb 文件结构：JSON { cells: [...], metadata, nbformat, nbformat_minor }
 * 每个 cell: { cell_type, source (string[]), metadata, outputs?, execution_count? }
 *
 * 设计选择：
 * - cell 用 id（.metadata.id 或索引）定位（对齐 Read 工具的 <cell id="..."> 输出）
 * - source 接受字符串，写入时按 \n 拆成 string[]（ipynb 的 source 格式是行数组）
 * - 原子写入：读→改→写 整个 JSON 文件
 */

import type {
  LegacyTool as Tool,
  LegacyToolResult as ToolResult,
  PermissionResult,
  ToolUseContext,
} from "./types.ts";
import { readFileSync, writeFileSync, statSync } from "fs";
import { extname } from "path";
import { getLogger } from "../debug/logger.ts";
import { normalizeToolPath, formatPathNotFoundError } from "./path-utils.ts";
import { pickPaths } from "./jit-affected-paths.ts";
import type { FileReadTracker } from "./file-read-tracker.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

/** NotebookEdit 的 zod schema */
const notebookEditSchema = lazySchema(() =>
  z.object({
    notebook_path: z.string().describe("notebook 文件的绝对路径（.ipynb）"),
    cell_id: z
      .string()
      .optional()
      .describe("要操作的 cell ID（replace/delete 必填，insert 时可选——省略则插到最前面）"),
    edit_mode: z.enum(["replace", "insert", "delete"]).default("replace").describe("编辑模式"),
    new_source: z.string().describe("新的 cell 内容（delete 模式时可为空串）"),
    cell_type: z
      .enum(["code", "markdown"])
      .optional()
      .describe("cell 类型（insert 时必填，replace 时可选——省略则保持原类型）"),
  }),
);

interface NotebookCell {
  cell_type: string;
  source: string[];
  metadata: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
  id?: string;
}

interface NotebookContent {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

/**
 * 将 source 字符串转为 ipynb 的行数组格式。
 * ipynb 约定：每行（除最后一行）以 \n 结尾。
 */
function sourceToLines(source: string): string[] {
  if (!source) return [];
  const lines = source.split("\n");
  // 除最后一行外，每行加 \n 后缀（ipynb 标准格式）
  return lines.map((line, i) => (i < lines.length - 1 ? line + "\n" : line));
}

/**
 * 从 cell 中提取用于匹配的 ID。
 * 优先级：cell.id > cell.metadata.id > 索引字符串
 */
function getCellId(cell: NotebookCell, index: number): string {
  if (cell.id) return cell.id;
  if (cell.metadata?.id && typeof cell.metadata.id === "string") return cell.metadata.id;
  return String(index);
}

/**
 * 在 notebook cells 中按 ID 查找索引。
 * 支持直接按 cell.id / cell.metadata.id / 数字索引匹配。
 */
function findCellIndex(cells: NotebookCell[], cellId: string): number {
  // 先按 id 字段精确匹配
  for (let i = 0; i < cells.length; i++) {
    if (getCellId(cells[i], i) === cellId) return i;
  }
  // 回退：数字索引
  const numIdx = parseInt(cellId, 10);
  if (!isNaN(numIdx) && numIdx >= 0 && numIdx < cells.length) return numIdx;
  return -1;
}

export class NotebookEditTool implements Tool {
  /**
   * zod schema：执行器据此做运行时校验（别名 / null 回填 / 数字归一 / safeParse），
   * registry 据此生成发给 LLM 的 JSON Schema。
   *
   * D2：此前只在 `inputSchema()` 里就地转 JSON Schema，实例上没挂 `zodSchema`，
   * 于是 `validateToolInput()` 走 `!schema` 早退——`edit_mode: "bogus"` 这类非法枚举
   * 直接进了 `execute()` 里的事后手工检查，没有结构化中文错误、也没有归一层的兜底。
   * 与 `inputSchema()` 共用同一份 schema（lazySchema 保证引用稳定），
   * 运行时校验器与发给模型的描述因此同源，不会漂移。
   */
  readonly zodSchema = notebookEditSchema();

  /** D11：编辑类：漏 required 字段会改错 notebook，strict 超限时优先保留（见 ToolCapabilityFields.strictPriority） */
  readonly strictPriority = 50;

  /**
   * PR-6（B8）：FileReadTracker——与 read/edit/write 共享同一实例。
   * 此前 notebook-edit 完全绕过并发冲突检测（不声明意图也不查冲突），
   * 其它会话对同一 .ipynb 的 edit/write 看不到它，它也无视别人的声明。
   * 现在：写盘前过 conflict-gate 共享闸门，写盘后回写内容快照 + declareFileIntent。
   * 未注入（null）时退回旧行为（不检测、不回写），保证测试与旧构造路径兼容。
   */
  private tracker: FileReadTracker | null;

  constructor(tracker?: FileReadTracker) {
    this.tracker = tracker ?? null;
  }

  name(): string {
    return "notebook_edit";
  }

  /** P2-9：JIT 上下文发现的路径自报（契约见 types.ts jitAffectedPaths） */
  jitAffectedPaths(input: unknown): string[] {
    return pickPaths(input, "notebook_path");
  }

  searchHint = "edit jupyter notebook cell ipynb";
  shouldDefer = true; // 延迟加载（ToolSearch 按需调出）
  // D6：guidance 是「何时该用」的意图映射（.ipynb 场景），与 searchHint（关键词）互补
  guidance = "编辑 Jupyter Notebook（.ipynb）的单个 cell 时用；普通文本/代码文件用 edit。";

  description(): string {
    return "编辑 Jupyter Notebook（.ipynb）的单个 cell。支持替换、插入新 cell、删除 cell。";
  }

  usageGuide(): string {
    return `- 先用 read 读取 notebook 查看 cell 结构和 id
- 支持三种 edit_mode: replace（替换已有 cell）、insert（在指定 cell 后插入）、delete（删除 cell）
- cell_id 对应 read 输出的 <cell id="..."> 中的 id
- insert 时如果省略 cell_id，新 cell 插入到 notebook 最前面
- insert 时 cell_type 是必填的（code 或 markdown）
- notebook_path 必须是绝对路径`;
  }

  readOnly(): boolean {
    return false;
  }

  async checkPermissions(input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    const path = (input as any)?.notebook_path;
    if (!path || typeof path !== "string") return { behavior: "passthrough" };
    return { behavior: "passthrough" };
  }

  inputSchema(): Record<string, unknown> {
    // 与上方 zodSchema 共用同一对象（lazySchema 缓存保证引用稳定）：registry 优先用
    // zodSchema 生成 LLM 定义，这条只在 zodSchema→JSON Schema 失败时作为回退路径；
    // 同源保证两条路径的产物逐字节相同，`docs:gen-reference --check` 不会因此漂移。
    return z.toJSONSchema(this.zodSchema) as Record<string, unknown>;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const log = getLogger();
    const params = input as {
      notebook_path: string;
      cell_id?: string;
      edit_mode?: "replace" | "insert" | "delete";
      new_source: string;
      cell_type?: "code" | "markdown";
    };

    if (!params.notebook_path) {
      return { output: "错误: 缺少 notebook_path 参数", isError: true };
    }

    const filePath = normalizeToolPath(params.notebook_path);
    if (extname(filePath) !== ".ipynb") {
      return { output: `错误: 文件不是 .ipynb notebook: ${filePath}`, isError: true };
    }

    const mode = params.edit_mode || "replace";

    // 读取 notebook
    let raw: string;
    let notebook: NotebookContent;
    try {
      raw = readFileSync(filePath, "utf-8");
      notebook = JSON.parse(raw);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        // 与 read/glob/edit/grep 统一走 formatPathNotFoundError：原文案不报当前工作目录，
        // 而相对路径是按会跟随 bash `cd` 的全局 cwd 解析的，模型看不出"路径是被哪个 cwd 拼出来的"。
        return { output: formatPathNotFoundError(filePath), isError: true };
      }
      return { output: `错误: 读取/解析 notebook 失败: ${err.message}`, isError: true };
    }

    if (!Array.isArray(notebook.cells)) {
      return { output: "错误: notebook 格式无效（缺少 cells 数组）", isError: true };
    }

    switch (mode) {
      case "replace": {
        if (!params.cell_id) {
          return { output: "错误: replace 模式需要 cell_id 参数", isError: true };
        }
        const idx = findCellIndex(notebook.cells, params.cell_id);
        if (idx === -1) {
          return { output: `错误: 未找到 cell_id="${params.cell_id}" 的 cell`, isError: true };
        }
        notebook.cells[idx].source = sourceToLines(params.new_source);
        if (params.cell_type) {
          notebook.cells[idx].cell_type = params.cell_type;
        }
        // 替换 code cell 时清空输出
        if (notebook.cells[idx].cell_type === "code") {
          notebook.cells[idx].outputs = [];
          notebook.cells[idx].execution_count = null;
        }
        break;
      }
      case "insert": {
        if (!params.cell_type) {
          return {
            output: "错误: insert 模式需要 cell_type 参数（code 或 markdown）",
            isError: true,
          };
        }
        const newCell: NotebookCell = {
          cell_type: params.cell_type,
          source: sourceToLines(params.new_source),
          metadata: {},
          ...(params.cell_type === "code" ? { outputs: [], execution_count: null } : {}),
        };
        if (params.cell_id) {
          const afterIdx = findCellIndex(notebook.cells, params.cell_id);
          if (afterIdx === -1) {
            return { output: `错误: 未找到 cell_id="${params.cell_id}" 的 cell`, isError: true };
          }
          notebook.cells.splice(afterIdx + 1, 0, newCell);
        } else {
          // 无 cell_id → 插到最前面
          notebook.cells.splice(0, 0, newCell);
        }
        break;
      }
      case "delete": {
        if (!params.cell_id) {
          return { output: "错误: delete 模式需要 cell_id 参数", isError: true };
        }
        const idx = findCellIndex(notebook.cells, params.cell_id);
        if (idx === -1) {
          return { output: `错误: 未找到 cell_id="${params.cell_id}" 的 cell`, isError: true };
        }
        notebook.cells.splice(idx, 1);
        break;
      }
      default:
        return { output: `错误: 未知的 edit_mode: ${mode}`, isError: true };
    }

    // PR-6（B8）：并发冲突闸门——与 edit/write 完全同口径（共享 conflict-gate.ts）：
    // block 阻止 / worktree 分支分叉自动放行（附说明）/ 同文件冲突弹窗裁决 / 无头降级。
    // 放在写回之前：拦下的操作不应留下半个已改的 notebook。
    let branchConflictNote = "";
    {
      const { runConflictGate } = await import("./conflict-gate.ts");
      const gate = await runConflictGate(filePath, "notebook_edit", this.tracker);
      if (!gate.proceed) {
        return { output: gate.output, isError: true };
      }
      branchConflictNote = gate.note;
    }

    // 写回
    try {
      const output = JSON.stringify(notebook, null, 1) + "\n";
      writeFileSync(filePath, output, "utf-8");

      // PR-6（B8）：写后回写 tracker 内容快照——notebook-edit 整文件重写 JSON，
      // 不回写则下一次 edit/write 的新鲜度比对会拿旧内容，把「模型自己刚做的
      // cell 编辑」误判为外部修改（对标 write.ts 的 BUG1 修复）。
      if (this.tracker) {
        try {
          const mtime = statSync(filePath).mtimeMs;
          if (this.tracker.hasBeenRead(filePath)) {
            this.tracker.updateMtime(filePath, output);
          } else {
            this.tracker.markAsRead(filePath, mtime, { isPartialView: false, content: output });
          }
        } catch {
          // stat 失败不阻断（文件已成功写入），仅丢失本次新鲜度记录。
        }

        // 声明编辑意图（其它会话的冲突检测据此可见本会话在改这个 notebook）
        if (this.tracker.sessionId && this.tracker.pid && this.tracker.cwd) {
          const { declareFileIntent } = await import("../session/file-intent.ts");
          declareFileIntent(
            this.tracker.sessionId,
            this.tracker.pid,
            this.tracker.cwd,
            filePath,
            "edit",
            this.tracker.parentSessionId,
          );
        }
      }
    } catch (err: any) {
      return { output: `错误: 写入 notebook 失败: ${err.message}`, isError: true };
    }

    const cellCount = notebook.cells.length;
    log.info("TOOL", `✓ notebook_edit ${mode} ${filePath} (${cellCount} cells)`);
    return {
      output: `成功: ${mode} 操作完成，notebook 现有 ${cellCount} 个 cell。${branchConflictNote}`,
    };
  }
}
