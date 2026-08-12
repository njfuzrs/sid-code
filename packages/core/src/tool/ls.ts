/**
 * Ls 工具 - 列举目录内容
 * 列举指定目录的直接子项（非递归），目录优先，显示文件大小
 */

import type {
  LegacyTool as Tool,
  LegacyToolResult as ToolResult,
  PermissionResult,
  ToolUseContext,
} from "./types.ts";
import { readdirSync, lstatSync, statSync, readlinkSync, type Dirent } from "fs";
import { join } from "path";
import { getLogger } from "../debug/logger.ts";
import { normalizeToolPath } from "./path-utils.ts";
import { pickPaths } from "./jit-affected-paths.ts";
import { getCwd } from "../bootstrap/state.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

/** 默认忽略的文件/目录名 */
const DEFAULT_IGNORE = new Set(["node_modules", ".git", "dist", ".DS_Store"]);

/**
 * 单次列举返回的最大条目数。
 * 对标 Claude Code GlobTool 的 limit/truncated 设计：超大目录一次性吐出会灌爆
 * LLM 上下文窗口（实测 2 万文件 ≈ 32.9 万字符 ≈ 8 万 token）。截断后给出明确提示，
 * 引导模型改用 glob 精确匹配或 ignore 过滤。
 */
const MAX_ENTRIES = 1000;

/**
 * 单次列举返回的最大字符数（第二道防线）。
 * 条目数未超 MAX_ENTRIES 但文件名极长时（实测 1000 个 200 字符文件名 ≈ 21 万字符），
 * 仍会撑爆上下文。对标 CC GlobTool 的 maxResultSizeChars:100_000，做字符级硬上限。
 */
const MAX_OUTPUT_CHARS = 100_000;

/** Ls 工具输入 schema —— 运行时校验 + JSON Schema 生成的唯一真相源 */
const lsSchema = lazySchema(() =>
  z.object({
    dir_path: z.string().describe("要列举的目录的绝对路径"),
    ignore: z
      .array(z.string())
      .optional()
      .describe("额外忽略的文件名模式（支持 * 通配符，如 ['*.log', 'tmp']）"),
  }),
);

/** 将字节数格式化为人类可读的大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 检查文件名是否匹配 ignore 模式（支持简单 glob：* 通配符） */
function matchesIgnorePattern(name: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      if (new RegExp(`^${regexStr}$`).test(name)) return true;
    } else {
      if (name === pattern) return true;
    }
  }
  return false;
}

/** 列举条目的分类：目录 / 文件 / 符号链接 / 断链或无法访问 */
type EntryKind = "dir" | "file" | "symlink-dir" | "symlink-file" | "broken";

interface LsEntry {
  name: string;
  kind: EntryKind;
  size: number;
  /** 符号链接目标（仅 symlink-* / broken 有值） */
  linkTarget?: string;
  /** 断链原因说明（仅 broken 有值），用于区分循环链接 / 目标不存在 / 权限不足 */
  brokenReason?: string;
}

export class LsTool implements Tool {
  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = lsSchema();

  /** P2-9：JIT 上下文发现的路径自报（契约见 types.ts jitAffectedPaths） */
  jitAffectedPaths(input: unknown): string[] {
    return pickPaths(input, "dir_path");
  }

  /**
   * G21：可选的"路径隐藏"判定回调（给定绝对路径 → 是否被权限 deny 规则命中）。
   * 命中的子项从列举结果剔除，对齐 claude-code「deny 文件不出现在 ls 列表」。
   * 未注入时行为完全不变（向后兼容）。
   */
  private isPathHidden?: (absPath: string) => boolean;

  constructor(isPathHidden?: (absPath: string) => boolean) {
    this.isPathHidden = isPathHidden;
  }

  /** G21：运行时注入/更新路径隐藏判定（构造时权限检查器尚未创建，故支持后置注入）。 */
  setPathHiddenFilter(fn: (absPath: string) => boolean): void {
    this.isPathHidden = fn;
  }

  readOnly(): boolean {
    return true;
  }

  /** 只读工具：无权限意见，交给权限系统决定 */
  async checkPermissions(_input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: "passthrough" };
  }

  name(): string {
    return "ls";
  }

  description(): string {
    return "列举目录的直接子项（非递归）。目录优先，同类按字母升序，显示文件大小与符号链接。";
  }

  usageGuide(): string {
    return `- 使用 ls 而不是 bash ls/find 来查看目录内容
- 只列举直接子项，不递归；递归查找请用 glob 工具
- 默认忽略 node_modules、.git、dist、.DS_Store
- 超过 ${MAX_ENTRIES} 项会截断，此时改用 glob 精确匹配或用 ignore 过滤
- dir_path 必须是绝对路径`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(lsSchema()) as Record<string, unknown>;
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as { dir_path: string; ignore?: string[] };

    if (!params.dir_path) {
      return { output: "错误: 缺少 dir_path 参数", isError: true };
    }

    let dirPath: string;
    try {
      dirPath = normalizeToolPath(params.dir_path);
    } catch (err: any) {
      return { output: `路径无效: ${err.message}`, isError: true };
    }

    // 起始即检查中断（对齐 grep/glob：executor 传入 signal 时接住）
    if (signal?.aborted) {
      return { output: "列举目录已取消", isError: true };
    }

    log.info("TOOL", `▶ 列举目录 ${dirPath}`);

    try {
      // 用 statSync（跟随符号链接）判断目标本身：允许 dir_path 指向"指向目录的符号链接"
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(dirPath);
      } catch {
        return { output: this.formatDirNotFound(dirPath), isError: true };
      }

      if (!stat.isDirectory()) {
        return { output: `错误: 路径不是目录: ${dirPath}`, isError: true };
      }

      // withFileTypes：一次系统调用同时拿到名称与类型，普通文件/目录无需再 stat，
      // 仅"需要 size 的文件"和"符号链接"才补 stat（减少约一半 statSync 调用）。
      let entries: Dirent[];
      try {
        entries = readdirSync(dirPath, { withFileTypes: true });
      } catch (err: any) {
        if (err?.code === "EACCES") {
          return {
            output: `错误: 无权限读取目录: ${dirPath}（权限被拒绝，请检查目录访问权限）`,
            isError: true,
          };
        }
        throw err;
      }

      const extraIgnore = params.ignore ?? [];
      const items: LsEntry[] = [];

      for (const dirent of entries) {
        // 周期性检查中断：超大目录逐项 stat 可能耗时，允许用户 ESC 取消
        if (signal?.aborted) {
          return { output: "列举目录已取消", isError: true };
        }

        const name = dirent.name;
        // 默认忽略
        if (DEFAULT_IGNORE.has(name)) continue;
        // 用户自定义忽略
        if (extraIgnore.length > 0 && matchesIgnorePattern(name, extraIgnore)) continue;
        // G21：权限 deny 规则隐藏——被拒的敏感文件不出现在列表里（对标 claude-code）。
        // 判定异常绝不吞结果：保守保留该项（宁可多显示也不因过滤器 bug 丢文件）。
        if (this.isPathHidden) {
          try {
            if (this.isPathHidden(join(dirPath, name))) continue;
          } catch {
            /* 判定失败则保留该项 */
          }
        }

        items.push(this.classifyEntry(dirPath, dirent));
      }

      if (items.length === 0) {
        return { output: `目录为空: ${dirPath}` };
      }

      // 目录优先（含指向目录的符号链接），同类按字母升序
      const isDirLike = (e: LsEntry) => e.kind === "dir" || e.kind === "symlink-dir";
      items.sort((a, b) => {
        const ad = isDirLike(a);
        const bd = isDirLike(b);
        if (ad !== bd) return ad ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      // 截断保护（第一道防线）：超大目录只保留前 MAX_ENTRIES 项
      const truncatedByCount = items.length > MAX_ENTRIES;
      let shown = truncatedByCount ? items.slice(0, MAX_ENTRIES) : items;

      // 字符级截断（第二道防线）：长文件名场景下条目数未超限但字符数溢出。
      // 逐项累加渲染行长度，超过 MAX_OUTPUT_CHARS 即停。
      let truncatedByChars = false;
      {
        let acc = dirPath.length + 32; // 预留标题/摘要行开销
        let keep = shown.length;
        for (let i = 0; i < shown.length; i++) {
          acc += shown[i].name.length + (shown[i].linkTarget?.length ?? 0) + 24; // 每行大致开销
          if (acc > MAX_OUTPUT_CHARS) {
            keep = i;
            truncatedByChars = true;
            break;
          }
        }
        if (truncatedByChars) shown = shown.slice(0, Math.max(keep, 1));
      }

      const truncated = truncatedByCount || truncatedByChars;

      const lines: string[] = [`目录列表：${dirPath}`, ""];
      let dirCount = 0;
      let fileCount = 0;
      let linkCount = 0;
      let brokenCount = 0;

      for (const item of shown) {
        switch (item.kind) {
          case "dir":
            lines.push(`[目录] ${item.name}/`);
            dirCount++;
            break;
          case "symlink-dir":
            lines.push(`[链接→目录] ${item.name}/ → ${item.linkTarget}`);
            dirCount++;
            linkCount++;
            break;
          case "symlink-file":
            lines.push(`[链接→文件] ${item.name} → ${item.linkTarget} (${formatSize(item.size)})`);
            fileCount++;
            linkCount++;
            break;
          case "broken":
            lines.push(
              `[断链] ${item.name} → ${item.linkTarget}（${item.brokenReason ?? "目标不存在或无法访问"}）`,
            );
            brokenCount++;
            break;
          default:
            lines.push(`${item.name} (${formatSize(item.size)})`);
            fileCount++;
        }
      }

      lines.push("");
      const parts = [`${dirCount} 个目录`, `${fileCount} 个文件`];
      if (linkCount > 0) parts.push(`${linkCount} 个符号链接`);
      if (brokenCount > 0) parts.push(`${brokenCount} 个断链`);
      lines.push(`共 ${shown.length} 项（${parts.join("，")}）`);

      if (truncated) {
        lines.push("");
        const reason = truncatedByCount
          ? `目录条目过多（共 ${items.length} 项）`
          : `目录输出过大（文件名过长）`;
        lines.push(
          `⚠️ ${reason}，仅显示前 ${shown.length} 项。` +
            `请改用 glob 工具精确匹配文件，或用 ignore 参数过滤后重试。`,
        );
      }

      log.info(
        "TOOL",
        `✓ 列举完成 ${dirCount}目录 ${fileCount}文件 ${linkCount}链接 ${brokenCount}断链${truncated ? " (已截断)" : ""}`,
      );

      return { output: lines.join("\n") };
    } catch (err: any) {
      return { output: `列举目录失败: ${err.message}`, isError: true };
    }
  }

  /**
   * 分类单个目录项：优先用 readdirSync 的 Dirent 类型判定（免 stat），
   * 仅"需要 size 的文件"和"符号链接"才补 stat/lstat。
   * 断链/循环链接会被标注而非静默丢弃（对标真实轨迹发现的数据丢失 bug）。
   */
  private classifyEntry(dirPath: string, dirent: Dirent): LsEntry {
    const name = dirent.name;
    const fullPath = join(dirPath, name);

    // 普通目录：Dirent 已知类型，无需 stat
    if (dirent.isDirectory()) {
      return { name, kind: "dir", size: 0 };
    }

    // 普通文件：仅补一次 stat 拿 size
    if (dirent.isFile()) {
      try {
        return { name, kind: "file", size: statSync(fullPath).size };
      } catch {
        // 竞态删除等：仍登记，size 置 0
        return { name, kind: "file", size: 0 };
      }
    }

    // 符号链接：readlink 拿目标，再 stat 解析目标类型
    if (dirent.isSymbolicLink()) {
      return this.classifySymlink(name, fullPath);
    }

    // 其它类型（FIFO/socket/块设备等）或 Dirent 类型未知：用 lstat 兜底
    let ls: ReturnType<typeof lstatSync>;
    try {
      ls = lstatSync(fullPath);
    } catch {
      // 连 lstat 都失败（极端权限/竞态）：仍然登记，标为断链，绝不静默丢弃
      return { name, kind: "broken", size: 0, linkTarget: "?", brokenReason: "无法访问" };
    }
    if (ls.isSymbolicLink()) return this.classifySymlink(name, fullPath);
    if (ls.isDirectory()) return { name, kind: "dir", size: 0 };
    return { name, kind: "file", size: ls.size };
  }

  /** 解析符号链接：区分指向目录/文件、循环链接(ELOOP)、目标不存在(ENOENT)、权限不足(EACCES) */
  private classifySymlink(name: string, fullPath: string): LsEntry {
    let linkTarget = "?";
    try {
      linkTarget = readlinkSync(fullPath);
    } catch {
      /* 读链接目标失败则保持 "?" */
    }
    // 解析链接目标：能 stat 到则区分目录/文件，否则按 errno 给出准确原因
    try {
      const target = statSync(fullPath);
      if (target.isDirectory()) {
        return { name, kind: "symlink-dir", size: 0, linkTarget };
      }
      return { name, kind: "symlink-file", size: target.size, linkTarget };
    } catch (err: any) {
      let brokenReason = "目标不存在或无法访问";
      if (err?.code === "ELOOP") brokenReason = "循环符号链接";
      else if (err?.code === "ENOENT") brokenReason = "目标不存在";
      else if (err?.code === "EACCES") brokenReason = "目标无访问权限";
      return { name, kind: "broken", size: 0, linkTarget, brokenReason };
    }
  }

  /**
   * 格式化"目录不存在"错误：提供 cwd + 掉 repo 目录纠错建议。
   * 对标 CC suggestPathUnderCwd —— 模型常构造出缺少当前仓库目录段的绝对路径。
   */
  private formatDirNotFound(dirPath: string): string {
    const cwd = getCwd();
    let hint = "";
    // 若传入路径与 cwd 完全相同却报不存在（竞态/刚被删），或路径不在 cwd 下，
    // 尝试"掉了 repo 目录"纠错：把路径最后若干段拼到 cwd 下看是否存在。
    if (dirPath !== cwd && !dirPath.startsWith(cwd + "/")) {
      const suggestion = this.suggestDirUnderCwd(dirPath, cwd);
      if (suggestion) hint = `\n是否想找: ${suggestion}`;
    }
    return `错误: 路径不存在: ${dirPath}\n当前工作目录: ${cwd}${hint}`;
  }

  /**
   * "掉了 repo 目录"纠错：cwd=/a/b/repo，请求 /a/b/sub（不存在），
   * 若 /a/b/repo/sub 存在则建议它。从最长后缀开始尝试匹配。
   */
  private suggestDirUnderCwd(requestedPath: string, cwd: string): string | undefined {
    const segs = requestedPath.split("/").filter(Boolean);
    // 从"最后 1 段"到"最后 N-1 段"逐步尝试拼到 cwd 下
    for (let take = 1; take < segs.length; take++) {
      const candidate = join(cwd, segs.slice(segs.length - take).join("/"));
      try {
        if (statSync(candidate).isDirectory()) return candidate;
      } catch {
        /* 继续尝试更长后缀 */
      }
    }
    return undefined;
  }
}
