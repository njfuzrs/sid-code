/**
 * Write 工具 - 写入文件内容
 * 自动创建目录，覆盖已存在的文件
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult, PermissionResult, ToolUseContext } from "./types.ts";
import { dirname, basename } from "path";
import { mkdirSync, existsSync } from "fs";
import { getLogger } from "../debug/logger.ts";
import { detectOmissionPlaceholders, isDocumentFile } from "./omission-detector.ts";
import { detectTruncation } from "./truncation-detector.ts";
import { normalizeToolPath } from "./path-utils.ts";
import { buildStructuredPatch } from "./diff-output.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

/** Write 工具输入 schema —— 运行时校验 + JSON Schema 生成的唯一真相源 */
const writeSchema = lazySchema(() =>
  z.object({
    file_path: z.string().describe("要写入的文件的绝对路径"),
    content: z.string().describe("要写入的内容"),
  }),
);

export class WriteTool implements Tool {
  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = writeSchema();

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

    // 省略占位符检测（文档文件跳过易误伤规则）
    const omissions = detectOmissionPlaceholders(params.content, isDocumentFile(filePath));
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

      // 读取旧内容(若已存在)以生成 diff;新建文件则旧内容为空
      let oldContent = "";
      const target = Bun.file(filePath);
      if (await target.exists()) {
        oldContent = await target.text();
      }

      // 写入文件
      await Bun.write(filePath, params.content);

      log.info("TOOL", `✓ 写入 ${filePath} 完成`);

      // 结构化 diff 直传 UI(新建 → 全 + 行;覆盖 → 增删对照)。
      // output 仅一句话摘要,不含完整 diff —— 对齐 claude-code 省 token。
      const action = oldContent ? "已写入" : "已创建";
      return {
        output: `文件${action}: ${filePath}`,
        structuredPatch: buildStructuredPatch(filePath, oldContent, params.content),
      };
    } catch (err: any) {
      return { output: `写入文件失败: ${err.message}`, isError: true };
    }
  }
}
