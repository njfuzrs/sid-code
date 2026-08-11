/**
 * /export 命令实现
 * 导出对话到剪贴板或文件（支持 Markdown 和 JSON 两种格式）
 *
 * 剪贴板受系统单一剪贴板约束，只能二选一格式；文件无此约束，
 * 可用 format="both" 一次生成 Markdown + JSON 两个独立文件。
 */

import * as path from "path";
import { writeFileSync } from "fs";
import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
import { setClipboard } from "../../../ink/termio/osc.ts";
import { serializeToMarkdown } from "./serialize-md.ts";
import { serializeToJson } from "./serialize-json.ts";
import { getVersion } from "../../../version.ts";

/** 剪贴板大小保护阈值 */
const CLIPBOARD_MD_MAX_BYTES = 256 * 1024;   // 256 KB
const CLIPBOARD_JSON_MAX_BYTES = 512 * 1024; // 512 KB

/** 单文件格式（用于序列化 + 剪贴板） */
export type SingleFormat = "md" | "json";
/** 导出格式；"both" 仅文件目标有效（同时生成 md + json 两个文件） */
export type ExportFormat = SingleFormat | "both";

export interface ExportOptions {
  target: "clipboard" | "file";
  format: ExportFormat;
  /** 用户指定的文件路径（仅单格式时有效；both 会自动命名两个文件） */
  filePath?: string;
}

/**
 * 解析命令参数，返回导出选项。
 * 无参返回 null（触发 Dialog）。
 */
function parseArgs(args: string, cwd: string): ExportOptions | null {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const first = tokens[0]!.toLowerCase();
  const second = tokens[1]?.toLowerCase();

  // 剪贴板快捷词（剪贴板只支持单格式，both 降级为 md）
  if (first === "clipboard" || first === "clip" || first === "cb") {
    const format: SingleFormat = second === "json" ? "json" : "md";
    return { target: "clipboard", format };
  }

  // 文件关键字（支持 both）
  if (first === "file") {
    const format: ExportFormat = second === "json" ? "json" : second === "both" ? "both" : "md";
    return { target: "file", format };
  }

  // 帮助
  if (first === "help" || first === "-h" || first === "--help") {
    return null; // 返回 null 会走 help 文本
  }

  // 视为文件路径（含 / 或 . 开头或有扩展名）
  const filePath = path.isAbsolute(tokens[0]!) ? tokens[0]! : path.join(cwd, tokens[0]!);
  const ext = path.extname(filePath).toLowerCase();
  const format: SingleFormat = ext === ".json" ? "json" : "md";
  return { target: "file", format, filePath };
}

/** 生成自动文件名 */
function generateFilename(format: SingleFormat): string {
  const now = new Date();
  const ts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `sid-export-${ts}.${format === "json" ? "json" : "md"}`;
}

/** 格式化字节大小 */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const messages = ctx.ctxMgr.getMessages();
    if (messages.length === 0) {
      return { type: "text", value: "当前没有对话记录可导出。" };
    }

    const opts = parseArgs(args, ctx.cwd);

    // 无参 → 打开 ExportDialog
    if (!opts) {
      return { type: "dialog", dialog: "export" };
    }

    return await executeExport(opts, ctx);
  },
};

/** 序列化单一格式的内容 */
function serialize(
  format: SingleFormat,
  messages: import("../../../llm/types.ts").Message[],
  serializeOpts: {
    sessionId: string;
    model: string;
    provider: string;
    cwd: string;
    sidCodeVersion: string;
  },
  forClipboard: boolean,
): string {
  if (format === "json") {
    const maxBytes = forClipboard ? CLIPBOARD_JSON_MAX_BYTES : undefined;
    return serializeToJson(messages, { ...serializeOpts, maxBytes });
  }
  const maxBytes = forClipboard ? CLIPBOARD_MD_MAX_BYTES : undefined;
  return serializeToMarkdown(messages, { ...serializeOpts, maxBytes });
}

/**
 * 执行导出逻辑（供命令和 Dialog 共用）
 */
export async function executeExport(
  opts: ExportOptions,
  ctx: CommandContext,
): Promise<LocalCommandResult> {
  const messages = ctx.ctxMgr.getMessages();
  const messageCount = messages.length;

  // 构建序列化选项
  const serializeOpts = {
    sessionId: ctx.sessionId,
    model: ctx.config.model || "(未配置)",
    provider: ctx.config.provider || "(未配置)",
    cwd: ctx.cwd,
    sidCodeVersion: getVersion(),
  };

  // ── 剪贴板：单一格式（both 已在解析层降级为 md） ──
  if (opts.target === "clipboard") {
    const format: SingleFormat = opts.format === "both" ? "md" : opts.format;
    const content = serialize(format, messages, serializeOpts, true);
    const sizeBytes = Buffer.byteLength(content, "utf-8");
    try {
      const oscSeq = await setClipboard(content);
      if (oscSeq) process.stdout.write(oscSeq);
    } catch {
      return { type: "text", value: "⚠ 剪贴板写入失败，请尝试保存到文件：/export file" };
    }
    const formatLabel = format === "json" ? "JSON" : "Markdown";
    return {
      type: "text",
      value: `✓ 已导出到剪贴板（${formatLabel}，${fmtSize(sizeBytes)}，${messageCount} 条消息）`,
    };
  }

  // ── 文件：单格式或双格式（both） ──
  const formats: SingleFormat[] = opts.format === "both" ? ["md", "json"] : [opts.format];
  const written: Array<{ path: string; format: SingleFormat; size: number }> = [];

  for (const format of formats) {
    const content = serialize(format, messages, serializeOpts, false);
    // both 时忽略用户指定路径（无法一路径写两格式），统一自动命名
    const filePath =
      opts.filePath && opts.format !== "both"
        ? opts.filePath
        : path.join(ctx.cwd, generateFilename(format));
    try {
      writeFileSync(filePath, content, { encoding: "utf-8" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { type: "text", value: `✗ 文件写入失败: ${msg}` };
    }
    written.push({ path: filePath, format, size: Buffer.byteLength(content, "utf-8") });
  }

  // 组装结果文本
  const totalSize = written.reduce((sum, w) => sum + w.size, 0);
  const warning = totalSize > 10 * 1024 * 1024 ? "\n⚠ 导出体积超过 10 MB，文件较大" : "";

  if (written.length === 1) {
    const w = written[0]!;
    const formatLabel = w.format === "json" ? "JSON" : "Markdown";
    return {
      type: "text",
      value: `✓ 已导出到 ${w.path}（${formatLabel}，${fmtSize(w.size)}，${messageCount} 条消息）${warning}`,
    };
  }

  // 多文件：逐行列出
  const lines = [
    `✓ 已导出 ${written.length} 个文件（${messageCount} 条消息）：`,
    ...written.map((w) => {
      const formatLabel = w.format === "json" ? "JSON" : "Markdown";
      return `  · ${w.path}（${formatLabel}，${fmtSize(w.size)}）`;
    }),
  ];
  return { type: "text", value: lines.join("\n") + warning };
}

export default mod;
