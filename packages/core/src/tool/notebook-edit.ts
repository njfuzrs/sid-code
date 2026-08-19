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
import { readFileSync, writeFileSync } from "fs";
import { extname } from "path";
import { getLogger } from "../debug/logger.ts";
import { normalizeToolPath, formatPathNotFoundError } from "./path-utils.ts";
import { pickPaths } from "./jit-affected-paths.ts";
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
  name(): string {
    return "notebook_edit";
  }

  /** P2-9：JIT 上下文发现的路径自报（契约见 types.ts jitAffectedPaths） */
  jitAffectedPaths(input: unknown): string[] {
    return pickPaths(input, "notebook_path");
  }

  searchHint = "edit jupyter notebook cell ipynb";
  shouldDefer = true; // 延迟加载（ToolSearch 按需调出）

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
    return z.toJSONSchema(notebookEditSchema()) as Record<string, unknown>;
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

    // 写回
    try {
      const output = JSON.stringify(notebook, null, 1) + "\n";
      writeFileSync(filePath, output, "utf-8");
    } catch (err: any) {
      return { output: `错误: 写入 notebook 失败: ${err.message}`, isError: true };
    }

    const cellCount = notebook.cells.length;
    log.info("TOOL", `✓ notebook_edit ${mode} ${filePath} (${cellCount} cells)`);
    return { output: `成功: ${mode} 操作完成，notebook 现有 ${cellCount} 个 cell。` };
  }
}
