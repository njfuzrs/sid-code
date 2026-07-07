/**
 * Write 工具 - 写入文件内容
 * 自动创建目录，覆盖已存在的文件
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult, PermissionResult, ToolUseContext } from "./types.ts";
import { dirname, basename } from "path";
import { mkdirSync, existsSync, statSync } from "fs";
import { getLogger } from "../debug/logger.ts";
import { detectOmissionPlaceholders, isDocumentFile, isPythonFile } from "./omission-detector.ts";
import { detectTruncation } from "./truncation-detector.ts";
import { normalizeToolPath } from "./path-utils.ts";
import { buildStructuredPatch } from "./diff-output.ts";
import type { FileReadTracker } from "./file-read-tracker.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

/** Write 工具输入 schema —— 运行时校验 + JSON Schema 生成的唯一真相源 */
const writeSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe("要写入的文件的绝对路径"),
    content: z.string().describe("要写入的内容"),
  }),
);

export class WriteTool implements Tool {
  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = writeSchema();

  /**
   * FileReadTracker：与 read/edit/read_many 共享同一实例，承载「先读后写」校验状态。
   * 未注入（null）时退回旧行为（不校验、不回写），保证测试与旧构造路径兼容。
   * 对标 claude-code FileWriteTool.validateInput / readFileState.set。
   */
  private tracker: FileReadTracker | null;

  constructor(tracker?: FileReadTracker) {
    this.tracker = tracker ?? null;
  }

  name(): string {
    return "write";
  }

  /** 工具级权限检查：敏感文件路径要求确认，其余 passthrough */
  async checkPermissions(input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    const filePath = (input as any)?.file_path;
    if (!filePath || typeof filePath !== "string") {
      return { behavior: "passthrough" };
    }
    const name = basename(filePath);
    if (name.startsWith(".env") || name === "credentials.json" || name.endsWith(".pem") || name.endsWith(".key")) {
      return { behavior: "ask", message: `写入敏感文件需要确认: ${filePath}` };
    }
    return { behavior: "passthrough" };
  }

  description(): string {
    return "写入内容到文件。如果文件已存在则覆盖，自动创建所需的目录。";
  }

  usageGuide(): string {
    return `- 使用 write 而不是 bash echo/cat 来创建文件
- 会自动创建不存在的父目录
- 如果文件已存在会被覆盖，修改已有文件请用 edit 工具
- file_path 必须是绝对路径
- 内容必须完整，禁止使用三个英文点号 ... 作为省略标记。Markdown 文档中用 Unicode 省略号 …（U+2026）代替
- ⚠️ 大文件分段写入：当内容超过约 300 行或预计很长时，不要一次性写入全部内容（会因输出上限截断导致写入失败）。正确做法：先 write 文件的前半部分，然后用 edit 工具或 bash 的 cat >> 逐段追加剩余内容。每段控制在 200-300 行以内`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(writeSchema()) as Record<string, unknown>;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const log = getLogger();
    const params = input as { file_path: string; content: string };

    if (!params.file_path) {
      return { output: "错误: 缺少 file_path 参数", isError: true };
    }

    if (params.content === undefined) {
      return { output: "错误: 缺少 content 参数", isError: true };
    }

    let filePath: string;
    try {
      filePath = normalizeToolPath(params.file_path);
    } catch (err: any) {
      return { output: `路径无效: ${err.message}`, isError: true };
    }

    // 省略占位符检测（文档文件跳过易误伤规则；Python 源码放行合法 `...` Ellipsis）
    const omissions = detectOmissionPlaceholders(params.content, isDocumentFile(filePath), isPythonFile(filePath));
    if (omissions.length > 0) {
      const details = omissions.map(m => `  行 ${m.line}: ${m.text}`).join("\n");
      return {
        output: `错误: 检测到省略占位符，请提供完整代码而非省略标记:\n${details}\n\n请重新生成完整的文件内容。`,
        isError: true,
      };
    }

    // 内容截断检测（文档文件跳过）：检测括号严重不平衡 / 末尾突然中断等高置信度信号。
    // 典型场景：LLM 输出撞 max_tokens，content 字段是半截代码/HTML。宁可漏报不误杀，
    // 命中即返回 isError 让模型改用分段写入，而非写入残破文件后自以为完成。
    // ⚠️ 仅对「覆盖已有文件」时检测——新建文件可能是分段写入的第一段（第一段
    // 嵌套 depth>=3 是正常的），如果此时拒绝会与分段建议自相矛盾导致死循环。
    const targetFile = Bun.file(filePath);
    const fileAlreadyExists = await targetFile.exists();
    if (fileAlreadyExists) {
      const truncation = detectTruncation(params.content, filePath);
      if (truncation.isTruncated) {
        log.warn("TOOL", `✗ 疑似截断内容，拒绝写入 ${filePath}: ${truncation.reason}`);
        return {
          output:
            `错误: 内容疑似被截断（${truncation.reason}）。这通常是因为一次性写入的内容超过了输出长度上限。\n` +
            `请改用分段策略：先 write 文件的前一部分，再用 edit 或 bash 的 cat >> 逐段追加剩余内容，` +
            `每段控制在 200-300 行以内。若确认内容本就完整（如含大量括号的正常代码），请重新完整写入一次。`,
          isError: true,
        };
      }
    }

    // 先读后写 + 陈旧检测守卫（对标 claude-code FileWriteTool.validateInput errorCode 2/3）。
    // ⚠️ 仅对「覆盖已有文件」生效——新建文件（fileAlreadyExists=false）无条件放行，
    // 否则 write 无法用来创建文件。覆盖已有文件必须满足：
    //   1. 已用 read 读取过（防凭空覆盖没看过的文件）
    //   2. 是完整读取而非部分视图（防冲掉未读区域）
    //   3. 读后未被外部修改（mtime 变且内容确实不同才拦，touch/formatter 不误伤）
    // 这三条与 edit 的护栏共用 FileReadTracker.validateForWrite/validateForEdit 同一实现，
    // 保证 write 与 edit 的先读后写语义永不漂移。
    // tracker 为 null（旧构造路径/测试）时整段跳过，退回改造前行为。
    if (fileAlreadyExists && this.tracker) {
      const freshErr = this.tracker.validateForWrite(filePath);
      if (freshErr) {
        log.warn("TOOL", `✗ 覆盖被拒: ${freshErr}`);
        return {
          output:
            `错误: ${freshErr}\n` +
            `（覆盖已存在文件前必须先完整 read，以免冲掉你未看过的内容或他人改动。` +
            `若只想改动其中一部分，请优先用 edit 工具。）`,
          isError: true,
        };
      }
    }

    // E.11 团队记忆 secret 守卫：写入团队记忆目录的内容若含 secret 直接拒绝
    // （团队记忆会同步给所有协作者，凭证绝不能进入）
    {
      const { checkTeamMemSecrets } = await import("../memory/team/secret-guard.ts");
      const { getTeamMemoryOptions } = await import("../memory/team/runtime.ts");
      const guardErr = checkTeamMemSecrets(filePath, params.content, getTeamMemoryOptions());
      if (guardErr) {
        log.warn("TOOL", `✗ 拒绝写入含 secret 的团队记忆: ${filePath}`);
        return { output: `错误: ${guardErr}`, isError: true };
      }
    }

    log.info("TOOL", `▶ 写入 ${filePath} (${params.content.length}字符)`);

    try {
      // 确保目录存在
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // 读取旧内容(若已存在)以生成 diff;新建文件则旧内容为空。
      // fileAlreadyExists 已在上方截断检测处求过值，复用以避免重复 stat。
      let oldContent = "";
      if (fileAlreadyExists) {
        oldContent = await targetFile.text();
      }

      // 写入文件
      await Bun.write(filePath, params.content);

      // BUG1 修复 + 内容快照同步：写入后回写 tracker，让紧接的 edit 不因"没读过"被拒，
      // 且记录刚写入的完整内容——否则下次 validateForWrite/validateForEdit 的内容比对会
      // 拿旧内容比对，把"模型自己刚写的新内容"误判为外部修改。对标 claude-code 写后
      // readFileState.set({content,...})。
      // 已有记录 → updateMtime(带 content) 刷新 mtime+内容+清 isPartialView；
      // 新建文件（首次写、无记录）→ markAsRead 建立完整视图记录。
      if (this.tracker) {
        try {
          const mtime = statSync(filePath).mtimeMs;
          if (this.tracker.hasBeenRead(filePath)) {
            this.tracker.updateMtime(filePath, params.content);
          } else {
            this.tracker.markAsRead(filePath, mtime, {
              isPartialView: false,
              content: params.content,
            });
          }
        } catch {
          // stat 失败不阻断（文件已成功写入），仅丢失本次新鲜度记录。
        }
      }

      log.info("TOOL", `✓ 写入 ${filePath} 完成`);

      // P3：行数骤降警告（edit-guard 模式）——覆盖已有文件时，若新内容行数比旧内容
      // 少 20% 以上（且旧文件 >50 行），在 output 里追加警告。这是 lost-in-the-middle
      // 的确定性兜底：模型自以为完成但实际丢了一大段。
      // 注意：这里不 reject（内容已写入）而是 warn——给模型一个"你可能丢了内容"的信号，
      // 让它自行检查。如果 reject 会导致已写入的文件状态与模型认知不一致。
      let lineDropWarning = "";
      if (oldContent) {
        const oldLines = oldContent.split("\n").length;
        const newLines = params.content.split("\n").length;
        if (oldLines > 50 && newLines < oldLines * 0.8) {
          const dropPct = Math.round((1 - newLines / oldLines) * 100);
          lineDropWarning =
            `\n⚠️ 警告：文件行数从 ${oldLines} 行降至 ${newLines} 行（减少 ${dropPct}%）。` +
            `请确认是否遗漏了原文件中的代码段（lost-in-the-middle）。` +
            `如果确实需要缩短文件则忽略此警告。`;
          log.warn("TOOL", `行数骤降警告: ${filePath} ${oldLines} → ${newLines} (↓${dropPct}%)`);
        }
      }

      // 结构化 diff 直传 UI(新建 → 全 + 行;覆盖 → 增删对照)。
      // output 仅一句话摘要,不含完整 diff —— 对齐 claude-code 省 token。
      const action = oldContent ? "已写入" : "已创建";
      return {
        output: `文件${action}: ${filePath}${lineDropWarning}`,
        structuredPatch: buildStructuredPatch(filePath, oldContent, params.content),
      };
    } catch (err: any) {
      // errno 友好化：把裸系统错误翻译成模型可操作的中文提示，避免弱模型
      // 对 EISDIR/ENOTDIR/EACCES 反复猜测。对标 claude-code 靠读前守卫提前
      // 拦掉大部分此类错误，这里作为兜底再补一层可读性。
      const code = err?.code as string | undefined;
      let hint = "";
      switch (code) {
        case "EISDIR":
          hint = `：目标路径是一个已存在的目录，无法作为文件写入。请检查 file_path 是否写成了目录路径。`;
          break;
        case "ENOTDIR":
          hint = `：路径中某一级父目录实际是文件而非目录，无法在其下创建文件。请检查 file_path 各级路径。`;
          break;
        case "EACCES":
        case "EPERM":
          hint = `：权限不足，无法写入。目标文件或其目录可能是只读的。`;
          break;
        case "EROFS":
          hint = `：目标位于只读文件系统，无法写入。`;
          break;
        case "ENOSPC":
          hint = `：磁盘空间不足，无法写入。`;
          break;
      }
      return { output: `写入文件失败${hint || `: ${err.message}`}`, isError: true };
    }
  }
}
