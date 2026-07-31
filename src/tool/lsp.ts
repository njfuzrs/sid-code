/**
 * LSP 查询工具 —— 与 Language Server Protocol 服务器交互，提供代码智能能力。
 *
 * 对齐 Claude Code 的 LSPTool，9 个操作：
 *   goToDefinition / findReferences / hover / documentSymbol / workspaceSymbol /
 *   goToImplementation / prepareCallHierarchy / incomingCalls / outgoingCalls
 *
 * 设计要点：
 * - 启用门控：自动检测（LSP 初始化成功且有服务器）即启用，无需环境变量（零配置体验）。
 * - 就绪等待：执行前 waitForLSPReady（服务器可能仍在初始化）。
 * - 文件保护：10MB 大小上限（G10），防止大文件拖垮 LSP 服务器。
 * - 结果过滤：location 类结果过滤 .gitignore 忽略的文件（G9）。
 * - 结果截断：最多 50 条 location（在 formatter 层），防止撑爆上下文。
 * - 只读 + 并发安全：纯查询操作，不改文件。
 */

import type {
  LegacyTool as Tool,
  LegacyToolResult as ToolResult,
  PermissionResult,
  ToolUseContext,
} from "./types.ts";
import { getLogger } from "../debug/logger.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";
import { pickPaths } from "./jit-affected-paths.ts";
import {
  formatLocations,
  formatHover,
  formatDocumentSymbols,
  formatWorkspaceSymbols,
  formatCallHierarchyItems,
  formatIncomingCalls,
  formatOutgoingCalls,
  formatCodeActions,
  normalizeLocations,
} from "./lsp-formatters.ts";

/** LSP 工具处理的文件大小上限（G10，对标 CC 的 10MB） */
const MAX_LSP_FILE_SIZE = 10 * 1024 * 1024;

/** 需要 line/character 定位的操作（workspaceSymbol 例外，它用 query） */
const POSITION_OPS = new Set([
  "goToDefinition",
  "findReferences",
  "hover",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
]);

const LSP_OPERATIONS = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
  "codeAction",
] as const;

type LSPOperation = (typeof LSP_OPERATIONS)[number];

interface LSPToolInput {
  operation: LSPOperation;
  filePath: string;
  line?: number;
  character?: number;
  query?: string;
}

const lspSchema = lazySchema(() =>
  z.object({
    operation: z
      .enum(LSP_OPERATIONS)
      .describe("要执行的 LSP 操作"),
    filePath: z
      .string()
      .describe("文件的绝对路径。所有操作都需要（workspaceSymbol 用它定位语言服务器）"),
    line: z
      .number()
      .int()
      .optional()
      .describe("行号（1-based，如编辑器所示）。位置相关操作必填，documentSymbol/workspaceSymbol 可省略；codeAction 可省略（省略=整文件范围）"),
    character: z
      .number()
      .int()
      .optional()
      .describe("列号（1-based，如编辑器所示）。位置相关操作必填；codeAction 可省略"),
    query: z
      .string()
      .optional()
      .describe("workspaceSymbol 的搜索关键词（符号名）"),
  }),
);

/**
 * 过滤掉被 .gitignore 忽略的文件路径（G9）。
 * 用 `git check-ignore --stdin` 批量检查；git 不可用或出错时不过滤（返回原列表）。
 *
 * export 供单测直接驱动（含 T5-B3 的 signal 快速退出/子进程 kill 分支）。
 */
export async function filterGitignored(
  paths: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const ignored = new Set<string>();
  if (paths.length === 0) return ignored;
  // T5-B3：入口快速退出——signal 已 abort 时不再 spawn git 子进程
  if (signal?.aborted) return ignored;
  let child: import("child_process").ChildProcess | null = null;
  try {
    const { spawn } = await import("child_process");
    child = spawn("git", ["check-ignore", "--stdin"], {
      cwd,
      stdio: ["pipe", "pipe", "ignore"],
    });
    // T5-B3：signal abort 时也 kill git 子进程，防止孤儿进程
    const onAbort = () => { if (!child!.killed) child!.kill(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    let stdout = "";
    // T5-B3：stdout 累积加 1MB 上限，防止异常大输出撑爆内存
    const STDOUT_CAP = 1_048_576;
    child.stdout!.on("data", (c: Buffer) => {
      if (stdout.length < STDOUT_CAP) stdout += c.toString();
    });
    const exitPromise = new Promise<void>((resolve) => {
      child!.on("close", () => resolve());
      child!.on("error", () => resolve());
    });
    child.stdin!.write(paths.join("\n"));
    child.stdin!.end();
    // 5s 超时兜底：超时后 kill 子进程，防止孤儿进程占用资源
    let timedOut = false;
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, 5000)),
    ]);
    signal?.removeEventListener("abort", onAbort);
    if (timedOut && !child.killed) {
      child.kill();
    }
    for (const line of stdout.trim().split("\n")) {
      if (line) ignored.add(line);
    }
  } catch {
    // git 不可用：不过滤
  } finally {
    // T5-B3 兜底：无论正常退出、超时还是异常，确保子进程不成孤儿
    if (child && !child.killed) {
      try { child.kill(); } catch { /* 进程已退出，kill 是 no-op */ }
    }
  }
  return ignored;
}

export class LSPTool implements Tool {
  readonly zodSchema = lspSchema();

  /** P2-9：JIT 上下文发现的路径自报（契约见 types.ts jitAffectedPaths） */
  jitAffectedPaths(input: unknown): string[] {
    return pickPaths(input, "filePath");
  }
  readonly searchHint = "code intelligence definition references hover symbols";

  name(): string {
    return "lsp";
  }

  readOnly(): boolean {
    return true;
  }

  isConcurrencySafe(): boolean {
    return true; // 纯只读查询，并发安全
  }

  /** 只读工具：无权限意见，交给权限系统决定 */
  async checkPermissions(_input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: "passthrough" };
  }

  description(): string {
    return (
      "与 Language Server Protocol（LSP）服务器交互，获取精确的代码智能信息：跳转定义、" +
      "查找引用、悬停类型/文档、文件符号列表、全工作区符号搜索、查找实现、调用层级、" +
      "以及获取确定性代码修复建议（codeAction quickfix）。" +
      "比文本搜索（grep）更精确——理解语言语义，能跨文件解析符号。"
    );
  }

  usageGuide(): string {
    return `- 行号/列号均为 1-based（与编辑器显示一致）
- 位置相关操作（goToDefinition/findReferences/hover/goToImplementation/prepareCallHierarchy/incomingCalls/outgoingCalls）必须提供 filePath + line + character，光标应落在目标符号上
- documentSymbol 只需 filePath（列出文件内所有符号）
- workspaceSymbol 用 query 搜索符号名（filePath 仅用于定位语言服务器，可传项目内任意文件）
- 调用层级两步走：先 prepareCallHierarchy 获取层级项，确认位置有效后再 incomingCalls（谁调用我）/ outgoingCalls（我调用谁）
- codeAction 拿语言服务器算好的确定性修复（quickfix）：补缺失 import、删未用变量等。给 filePath 查整文件的修复建议，或加 line/character 只查光标处那条诊断的修复。返回的是"改哪里 → 改成什么"，你据此用 edit 工具落地（本操作只读、不自动改文件）。修复类错误时优先查它，省去自行推理
- 内置支持 TypeScript/JavaScript/Vue/Python/Go/Rust/JSON/YAML/HTML/CSS/Shell：装好对应 language server 即自动生效；未安装时工具会返回精准安装引导。长尾语言可在 ~/.sid-code/lsp.json 自行配置
- 优先用它而非 grep 做符号级导航：grep 只匹配文本，lsp 理解语义`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(lspSchema()) as Record<string, unknown>;
  }

  /**
   * 启用条件：LSP 初始化成功且有可用服务器。
   * 自动检测，无需环境变量门控——有 LSP 就启用（零配置体验，差异化于 CC 的 ENABLE_LSP_TOOL）。
   */
  isEnabled(): boolean {
    // 同步检查，不能 await。getLSPInitState/getLSPManager 都是同步读单例。
    // 注意：isEnabled 在工具组装时调用，此时 LSP 可能仍在 pending；返回 false 不影响
    // 后续——LSP 就绪后下次组装即启用。但为了让工具"早可见"（pending 也算潜在可用），
    // 这里只要不是明确 failed/not-started 就放行，真正的就绪由 execute 的 waitForLSPReady 兜底。
    try {
      // 用 require 同步引入，避免 isEnabled 变 async（接口是同步的）
      const { getLSPInitState } = require("../lsp/manager.ts");
      const state = getLSPInitState();
      return state === "success" || state === "pending";
    } catch {
      return false;
    }
  }

  async execute(input: unknown, _signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as LSPToolInput;

    // ── 参数校验 ──
    if (!params.operation || !params.filePath) {
      return { output: "错误: 缺少 operation 或 filePath 参数", isError: true };
    }
    if (POSITION_OPS.has(params.operation)) {
      if (params.line == null || params.character == null) {
        return {
          output: `错误: 操作 ${params.operation} 需要 line 和 character 参数（1-based）`,
          isError: true,
        };
      }
    }
    if (params.operation === "workspaceSymbol" && !params.query) {
      return { output: "错误: workspaceSymbol 操作需要 query 参数", isError: true };
    }

    // ── LSP 就绪等待（G5）──
    const { waitForLSPReady, getLSPManager } = await import("../lsp/manager.ts");
    const ready = await waitForLSPReady();
    if (!ready) {
      return {
        output: "LSP 服务器未就绪或未配置。请确认对应语言的 language server 已安装并在 PATH 中（内置支持 TypeScript/Vue/Python/Go/Rust 等，装好即自动生效）。",
        isError: true,
      };
    }
    const manager = getLSPManager();
    if (!manager) {
      return { output: "LSP 系统不可用", isError: true };
    }

    // ── 路由检查：该文件有无对应服务器 ──
    const server = manager.getServerForFile(params.filePath);
    if (!server) {
      // 路由未命中：给出精准引导（内置支持则告知装什么、怎么装；长尾语言则引导配置），
      // 而非笼统的"未配置"。参见 builtin-servers.describeMissingServer。
      const { describeMissingServer } = await import("../lsp/builtin-servers.ts");
      const { sidPaths } = await import("../config/paths.ts");
      return {
        output: describeMissingServer(params.filePath, sidPaths.lspConfig()),
        isError: true,
      };
    }

    // ── 文件大小保护（G10）+ 读取内容用于 didOpen ──
    let content: string;
    try {
      const { stat, readFile } = await import("fs/promises");
      const st = await stat(params.filePath);
      if (st.size > MAX_LSP_FILE_SIZE) {
        return {
          output: `文件过大 (${(st.size / 1024 / 1024).toFixed(1)}MB)，超过 LSP 处理限制 (10MB)`,
          isError: true,
        };
      }
      content = await readFile(params.filePath, "utf-8");
    } catch (err: any) {
      return { output: `无法读取文件 ${params.filePath}: ${err.message}`, isError: true };
    }

    // ── 确保文件已在 LSP 服务器侧打开 ──
    try {
      await manager.openFile(params.filePath, content);
    } catch (err: any) {
      log.debug("LSP", `openFile 失败 ${params.filePath}: ${err.message}`);
    }

    // workspaceFolder 用于结果路径展示与 gitignore 过滤（取服务器配置，回退 cwd）
    const workspaceFolder = server.config.workspaceFolder ?? process.cwd();

    try {
      return await this.dispatch(params, manager, workspaceFolder, _signal);
    } catch (err: any) {
      log.warn("LSP", `${params.operation} 执行失败: ${err.message}`);
      return { output: `LSP ${params.operation} 失败: ${err.message}`, isError: true };
    }
  }

  /** 按操作分派到对应 LSP 请求并格式化结果 */
  private async dispatch(
    params: LSPToolInput,
    manager: import("../lsp/server-manager.ts").LSPServerManager,
    workspaceFolder: string,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const { pathToFileURL } = await import("url");
    const uri = pathToFileURL(params.filePath).href;
    // LSP 协议用 0-based 行列，工具输入是 1-based，这里转换
    const position =
      params.line != null && params.character != null
        ? { line: params.line - 1, character: params.character - 1 }
        : undefined;
    const textDocument = { uri };

    switch (params.operation) {
      case "goToDefinition": {
        const result = await manager.sendRequest(params.filePath, "textDocument/definition", {
          textDocument,
          position,
        });
        const filtered = await this.filterLocationResult(result, workspaceFolder, signal);
        return { output: formatLocations(filtered, workspaceFolder, "未找到定义") };
      }
      case "goToImplementation": {
        const result = await manager.sendRequest(params.filePath, "textDocument/implementation", {
          textDocument,
          position,
        });
        const filtered = await this.filterLocationResult(result, workspaceFolder, signal);
        return { output: formatLocations(filtered, workspaceFolder, "未找到实现") };
      }
      case "findReferences": {
        const result = await manager.sendRequest(params.filePath, "textDocument/references", {
          textDocument,
          position,
          context: { includeDeclaration: true },
        });
        const filtered = await this.filterLocationResult(result, workspaceFolder, signal);
        return { output: formatLocations(filtered, workspaceFolder, "未找到引用") };
      }
      case "hover": {
        const result = await manager.sendRequest(params.filePath, "textDocument/hover", {
          textDocument,
          position,
        });
        return { output: formatHover(result) };
      }
      case "documentSymbol": {
        const result = await manager.sendRequest(params.filePath, "textDocument/documentSymbol", {
          textDocument,
        });
        return { output: formatDocumentSymbols(result, workspaceFolder) };
      }
      case "workspaceSymbol": {
        const result = await manager.sendRequest(params.filePath, "workspace/symbol", {
          query: params.query,
        });
        return { output: formatWorkspaceSymbols(result, workspaceFolder) };
      }
      case "prepareCallHierarchy": {
        const result = await manager.sendRequest(
          params.filePath,
          "textDocument/prepareCallHierarchy",
          { textDocument, position },
        );
        return { output: formatCallHierarchyItems(result, workspaceFolder) };
      }
      case "incomingCalls":
      case "outgoingCalls": {
        // 调用层级需先 prepare 拿到 item，再用 item 查 incoming/outgoing。
        const items = (await manager.sendRequest(
          params.filePath,
          "textDocument/prepareCallHierarchy",
          { textDocument, position },
        )) as unknown[];
        if (!items || !Array.isArray(items) || items.length === 0) {
          return {
            output: "此位置无可用的调用层级项（请确认光标位于函数/方法名上）",
            isError: false,
          };
        }
        const item = items[0];
        if (params.operation === "incomingCalls") {
          const result = await manager.sendRequest(params.filePath, "callHierarchy/incomingCalls", {
            item,
          });
          return { output: formatIncomingCalls(result, workspaceFolder) };
        } else {
          const result = await manager.sendRequest(params.filePath, "callHierarchy/outgoingCalls", {
            item,
          });
          return { output: formatOutgoingCalls(result, workspaceFolder) };
        }
      }
      case "codeAction": {
        // 关键修复（对比原方案的致命缺陷）：多数语言服务器在 context.diagnostics 为空时
        // 返回空 quickfix 列表——它不知道要修什么。这里从被动诊断注册表**只读快照**取该文件
        // 当前诊断填充 context，绝不消费 pending（否则 G1 每轮诊断注入链断掉）。
        const { getDiagnosticRegistry } = await import("../lsp/manager.ts");
        const registry = getDiagnosticRegistry();
        const allDiags = registry ? registry.peekDiagnosticsForFile(uri) : [];

        // 有 position：把范围收窄到光标所在行，只查该行诊断的修复（更聚焦、结果更少）；
        // 无 position：整文件范围 + 全部诊断（查整个文件有哪些可用修复）。
        const severityToNum: Record<string, number> = { Error: 1, Warning: 2, Info: 3, Hint: 4 };
        let range: { start: { line: number; character: number }; end: { line: number; character: number } };
        let contextDiags = allDiags;
        if (position) {
          range = { start: position, end: position };
          contextDiags = allDiags.filter((d) => {
            const s = d.range?.start?.line ?? -1;
            const e = d.range?.end?.line ?? s;
            return position.line >= s && position.line <= e;
          });
        } else {
          // 整文件范围：用第一条诊断到末尾兜底一个大范围（服务器按 context.diagnostics 决定返回）
          range = { start: { line: 0, character: 0 }, end: { line: 999_999, character: 0 } };
        }

        // 转成 LSP 协议诊断形态（数字 severity），供服务器匹配对应 quickfix
        const lspDiagnostics = contextDiags.map((d) => ({
          range: d.range,
          severity: severityToNum[d.severity] ?? 3,
          code: d.code,
          source: d.source,
          message: d.message,
        }));

        const result = await manager.sendRequest(params.filePath, "textDocument/codeAction", {
          textDocument,
          range,
          context: { diagnostics: lspDiagnostics, only: ["quickfix"] },
        });
        return { output: formatCodeActions(result, workspaceFolder) };
      }
      default: {
        // 类型上 LSP_OPERATIONS 已穷举，这里兜底未知操作
        return { output: `不支持的操作: ${params.operation}`, isError: true };
      }
    }
  }

  /**
   * 过滤 location 类结果中被 .gitignore 忽略的文件（G9）。
   * 把结果归一化为 Location[]，提取磁盘路径批量交给 git check-ignore，
   * 剔除被忽略项后返回过滤后的原始结果数组。
   */
  private async filterLocationResult(result: unknown, workspaceFolder: string, signal?: AbortSignal): Promise<unknown> {
    if (!result) return result;
    const arr = Array.isArray(result) ? result : [result];
    if (arr.length === 0) return result;

    // 提取每项的展示路径（绝对/相对），用于 gitignore 检查
    const locations = normalizeLocations(result);
    if (locations.length === 0) return result;

    const { fileURLToPath } = await import("url");
    const pathOf = (uri: string): string | null => {
      try {
        return fileURLToPath(uri);
      } catch {
        return null;
      }
    };

    const absPaths = locations
      .map((l) => pathOf(l.uri))
      .filter((p): p is string => p !== null);
    const ignored = await filterGitignored(absPaths, workspaceFolder, signal);
    if (ignored.size === 0) return result; // 无忽略项，原样返回

    // 过滤原始数组：保留 uri 对应磁盘路径不在 ignored 中的项
    const keep = arr.filter((item: any) => {
      const u = item?.uri ?? item?.targetUri;
      if (typeof u !== "string") return true;
      const p = pathOf(u);
      return p === null || !ignored.has(p);
    });
    return keep;
  }
}
