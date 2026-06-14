/**
 * Write 工具 - 写入文件内容
 * 自动创建目录，覆盖已存在的文件
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult, PermissionResult, ToolUseContext } from "./types.ts";
import { dirname, basename } from "path";
import { mkdirSync, existsSync } from "fs";
import { getLogger } from "../debug/logger.ts";
import { detectOmissionPlaceholders, isDocumentFile } from "./omission-detector.ts";
import { normalizeToolPath } from "./path-utils.ts";
import { buildStructuredPatch } from "./diff-output.ts";

export class WriteTool implements Tool {
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
- 内容必须完整，禁止使用三个英文点号 ... 作为省略标记。Markdown 文档中用 Unicode 省略号 …（U+2026）代替`;
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "要写入的文件的绝对路径",
        },
        content: {
          type: "string",
          description: "要写入的内容",
        },
      },
      required: ["file_path", "content"],
    };
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
