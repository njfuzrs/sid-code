/**
 * 系统提示词构建模块
 * 对标 Claude Code，包含：身份、环境信息、工具指南、行为约束、项目规则
 */

import type { Tool } from "../tool/types.ts";
import { platform, homedir } from "os";
import { cwd } from "process";

/** 系统提示词构建上下文 */
export interface SystemPromptContext {
  /** 已注册的工具实例（用于获取 usageGuide） */
  tools: Tool[];
  /** 项目规则（CLAUDE.md 内容） */
  projectRules?: string;
  /** 追加的系统提示词 */
  appendPrompt?: string;
  /** 从文件加载的系统提示词 */
  filePrompt?: string;
}

/**
 * 构建完整的系统提示词
 * 包含：身份、环境、工具指南、约束、项目规则
 */
export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const parts: string[] = [];

  // 1. 身份指令
  parts.push(buildIdentitySection());

  // 2. 环境信息
  parts.push(buildEnvironmentSection());

  // 3. 工具使用指南
  if (ctx.tools.length > 0) {
    parts.push(buildToolGuideSection(ctx.tools));
  }

  // 4. 行为约束
  parts.push(buildConstraintsSection());

  // 5. 项目规则（CLAUDE.md）
  if (ctx.projectRules) {
    parts.push(`\n<project-rules>\n${ctx.projectRules}\n</project-rules>`);
  }

  // 6. 追加提示词
  if (ctx.appendPrompt) {
    parts.push(`\n${ctx.appendPrompt}`);
  }

  // 7. 文件提示词
  if (ctx.filePrompt) {
    parts.push(`\n${ctx.filePrompt}`);
  }

  return parts.join("\n");
}

/** 构建身份指令部分 */
function buildIdentitySection(): string {
  return `你是 sid-code AI 编程助手，一个专业的代码辅助工具。你可以：
- 帮助用户编写、修改、调试代码
- 执行 shell 命令、读写文件
- 解释技术概念、提供最佳实践建议
- 使用工具完成复杂任务

你的回复应该简洁、专业、可操作。`;
}

/** 构建环境信息部分 */
function buildEnvironmentSection(): string {
  const workDir = cwd();
  const homeDir = homedir();
  const os = platform();
  const shell = process.env.SHELL || "unknown";
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  return `
<environment>
## 环境信息
- 工作目录: ${workDir}
- 用户主目录: ${homeDir}
- 操作系统: ${os}
- Shell: ${shell}
- 当前日期: ${date}
</environment>`;
}

/** 构建工具使用指南部分 */
function buildToolGuideSection(tools: Tool[]): string {
  const toolList = tools.map((t) => `  - ${t.name()}: ${t.description()}`).join("\n");

  // 收集工具自带的使用指南
  const customGuides: string[] = [];
  for (const tool of tools) {
    if (tool.usageGuide) {
      const guide = tool.usageGuide();
      if (guide) {
        customGuides.push(`\n### ${tool.name()} 工具使用指南\n${guide}`);
      }
    }
  }

  return `
<tool-guide>
## 可用工具
你可以使用以下工具完成任务：

${toolList}

### 工具使用原则
1. **优先使用专用工具**：例如用 read 读文件，不要用 bash cat
2. **并行执行只读工具**：多个 read/grep/glob 可以并行调用
3. **串行执行写入工具**：write/edit/bash 必须串行执行，避免冲突
4. **先读后写**：修改文件前必须先用 read 读取内容
5. **验证结果**：执行写入操作后，用 read 或 bash 验证结果
6. **错误处理**：工具执行失败时，分析错误原因，调整参数重试

### 常见任务模式
- **读取文件**: 使用 read 工具，支持行偏移和限制
- **搜索文件**: 使用 glob 工具（按文件名）或 grep 工具（按内容）
- **修改文件**: 先 read 读取，再 edit 精确替换（不要用 bash sed）
- **创建文件**: 使用 write 工具（不要用 bash echo 或 cat）
- **执行命令**: 使用 bash 工具，设置合理的超时时间
${customGuides.length > 0 ? "\n" + customGuides.join("\n") : ""}
</tool-guide>`;
}

/** 构建行为约束部分 */
function buildConstraintsSection(): string {
  return `
<constraints>
## 行为约束
1. **语言要求**: 所有回复、代码注释、文档均使用中文
2. **先确认再行动**: 对于破坏性操作（删除文件、强制推送等），先向用户确认
3. **最小化修改**: 只修改必要的代码，不要过度重构或添加不必要的功能
4. **保持简洁**: 回复简洁明了，避免冗长的解释
5. **安全第一**: 不执行危险命令，不泄露敏感信息
6. **验证假设**: 不确定时，先用工具验证（如检查文件是否存在）
7. **错误透明**: 遇到错误时，如实告知用户，不要隐藏或猜测
</constraints>`;
}
