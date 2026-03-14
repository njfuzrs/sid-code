/**
 * Edit 工具 - 编辑文件内容
 * 通过字符串查找替换来修改文件
 * 要求：必须先用 Read 工具读取文件后才能编辑（先读后改）
 */

import type { Tool, ToolResult } from "./types.ts";
import type { FileReadTracker } from "./file-read-tracker.ts";

export class EditTool implements Tool {
  private tracker: FileReadTracker | null;

  constructor(tracker?: FileReadTracker) {
    this.tracker = tracker ?? null;
  }

  name(): string {
    return "edit";
  }

  description(): string {
    return "通过查找替换来编辑文件内容。必须先用 read 工具读取文件后才能编辑。old_string 必须在文件中唯一存在，否则操作失败。";
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "要编辑的文件的绝对路径",
        },
        old_string: {
          type: "string",
          description: "要替换的原始字符串（必须在文件中唯一）",
        },
        new_string: {
          type: "string",
          description: "替换后的新字符串",
        },
        replace_all: {
          type: "boolean",
          description: "是否替换所有匹配项（默认 false，要求唯一匹配）",
        },
      },
      required: ["file_path", "old_string", "new_string"],
    };
  }

  async execute(input: unknown): Promise<ToolResult> {
    const params = input as {
      file_path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    };

    if (!params.file_path || !params.old_string || params.new_string === undefined) {
      return { output: "错误: 缺少必需参数", isError: true };
    }

    // 先读后改校验
    if (this.tracker) {
      const error = this.tracker.validateForEdit(params.file_path);
      if (error) {
        return { output: `错误: ${error}`, isError: true };
      }
    }

    try {
      const file = Bun.file(params.file_path);
      const exists = await file.exists();
      if (!exists) {
        return { output: `错误: 文件不存在: ${params.file_path}`, isError: true };
      }

      let content = await file.text();

      // 智能引号处理：把弯引号转成直引号再匹配
      let searchStr = params.old_string;
      if (!content.includes(searchStr)) {
        const normalized = this.normalizeQuotes(searchStr);
        if (normalized !== searchStr && content.includes(normalized)) {
          searchStr = normalized;
        }
      }

      // 行号前缀剥离：如果 old_string 包含行号前缀（如 "123→"），自动去掉
      if (!content.includes(searchStr)) {
        const stripped = this.stripLineNumbers(searchStr);
        if (stripped !== searchStr && content.includes(stripped)) {
          searchStr = stripped;
        }
      }

      // 检查匹配次数
      const matches = content.split(searchStr).length - 1;
      if (matches === 0) {
        return { output: "错误: 未找到要替换的字符串", isError: true };
      }

      if (!params.replace_all && matches > 1) {
        return {
          output: `错误: 找到 ${matches} 处匹配，但 replace_all=false。请提供更具体的 old_string 或设置 replace_all=true`,
          isError: true,
        };
      }

      // 执行替换
      if (params.replace_all) {
        content = content.split(searchStr).join(params.new_string);
      } else {
        content = content.replace(searchStr, params.new_string);
      }

      // 写回文件
      await Bun.write(params.file_path, content);

      // 更新 tracker 中的 mtime
      if (this.tracker) {
        this.tracker.updateMtime(params.file_path);
      }

      return {
        output: `文件已编辑: ${params.file_path}（替换了 ${matches} 处）`,
      };
    } catch (err: any) {
      return { output: `编辑文件失败: ${err.message}`, isError: true };
    }
  }

  /** 把弯引号（Word 复制出来的）转成直引号 */
  private normalizeQuotes(str: string): string {
    return str
      .replace(/[\u2018\u2019]/g, "'")   // 单引号
      .replace(/[\u201C\u201D]/g, '"');   // 双引号
  }

  /** 剥离行号前缀（如 "  123→content" → "content"） */
  private stripLineNumbers(str: string): string {
    return str
      .split("\n")
      .map(line => line.replace(/^\s*\d+→/, ""))
      .join("\n");
  }
}
