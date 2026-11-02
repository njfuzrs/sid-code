import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

/** /init 命令 — 初始化项目配置目录 */
/**
 * M1：`/init` 代码库分析 prompt（中文，对齐全局中文约定）。
 * 驱动模型 agentic 地扫描仓库、发现 build/test/lint 命令与项目约定，
 * 生成（或改进）一份真实、具体、可验证的 CLAUDE.md，而非占位符。
 * 对齐 CC commands/init.ts 的 type: 'prompt' 做法。
 */
const INIT_ANALYSIS_PROMPT = `请为当前代码库生成（或改进）一份 \`CLAUDE.md\` 文件，用于给未来在此仓库工作的 AI 编码助手提供指导。

## 执行步骤

1. **扫描项目结构**：用 glob/ls 查看项目根与关键子目录，识别整体布局与模块划分。
2. **识别技术栈与工具链**：读取以下文件（存在才读）推断语言、框架、包管理器：
   - \`package.json\` / \`bun.lockb\` / \`pnpm-lock.yaml\`（Node/前端）
   - \`Cargo.toml\`（Rust）、\`go.mod\`（Go）、\`pom.xml\` / \`build.gradle\`（Java/Kotlin）
   - \`pyproject.toml\` / \`requirements.txt\` / \`setup.py\`（Python）
   - \`Makefile\` / \`Justfile\` / \`Taskfile.yml\`（任务运行器）
3. **提取关键命令**：从上述文件的 scripts/targets 中找出真实的 **构建 / 测试 / lint / 类型检查 / 启动** 命令，务必写实际命令（如 \`bun test\`、\`make build\`），不要写占位符。
4. **提炼项目约定**：读 \`README\`、现有 \`CLAUDE.md\`、\`.gitignore\`、CI 配置（\`.github/workflows/\` 等），提炼编码风格、目录约定、提交规范、测试要求等。
5. **检查现有 CLAUDE.md**：
   - **若已存在**：先读取全文，以「改进建议」形式提出具体修改（缺什么、哪里过时），**不要静默覆盖**。除非用户明确要求重写，否则保留用户已有内容，只做增量补充。
   - **若不存在**：写一份新的 CLAUDE.md。

## CLAUDE.md 内容要求

- **语言**：用中文撰写（对齐本项目约定）。
- **长度**：目标 200 行以内，聚焦高价值信息，不要冗余。
- **结构建议**：项目简介 / 技术栈 / 常用命令（build、test、lint、run）/ 目录结构说明 / 编码约定 / 注意事项。
- **具体可验证**：每条命令、每个约定都应能被实际执行或核对，避免空泛描述。
- 若发现 \`.cursorrules\`、\`.github/copilot-instructions.md\` 等其它 AI 规则文件，可整合其有价值内容。

完成后，简要说明你做了哪些改动（新建还是改进、包含哪些关键命令），并提示用户可运行 \`/init --dirs-only\` 初始化 \`.sid-code/\` 自定义目录脚手架。`;

/**
 * M1：`/init` 命令。
 * - 默认（无参 / 非 --dirs-only）：返回 submit_prompt，驱动模型 agentic 分析代码库生成真实 CLAUDE.md。
 * - \`--dirs-only\`：仅执行 \`.sid-code/\` 目录脚手架（保留旧行为，不再写占位 CLAUDE.md）。
 */
export class InitCommand implements LocalCommandModule {
  async call(args: string, _ctx: CommandContext): Promise<LocalCommandResult> {
    const dirsOnly = /(^|\s)--dirs-only(\s|$)/.test(args);

    // 默认路径：注入代码库分析 prompt，交给模型 agentic 执行（对齐 CC type: 'prompt'）。
    if (!dirsOnly) {
      return { type: "submit_prompt", prompt: INIT_ANALYSIS_PROMPT };
    }

    // --dirs-only：仅做目录脚手架（旧脚手架能力保留，但不再写占位 CLAUDE.md）。
    const fs = await import("fs/promises");
    const path = await import("path");
    const cwd = process.cwd();

    const dirs = [".sid-code/commands", ".sid-code/skills", ".sid-code/agents"];

    const created: string[] = [];
    const skipped: string[] = [];

    for (const dir of dirs) {
      const fullPath = path.join(cwd, dir);
      try {
        await fs.mkdir(fullPath, { recursive: true });
        created.push(dir);
      } catch {
        skipped.push(dir);
      }
    }

    const lines: string[] = [];
    if (created.length > 0) lines.push(`已创建目录:\n${created.map((d) => `  ${d}/`).join("\n")}`);
    if (skipped.length > 0)
      lines.push(`已存在（跳过）:\n${skipped.map((d) => `  ${d}/`).join("\n")}`);

    lines.push(
      "\n提示：",
      "  .sid-code/commands/ — 放置自定义斜杠命令 (.md)",
      "  .sid-code/skills/   — 放置 Skills 提示词模板 (.md)",
      "  .sid-code/agents/   — 放置自定义 Agent 定义 (.md)",
      "\n运行不带参数的 /init 可分析代码库并生成 CLAUDE.md。",
    );

    return { type: "text", value: lines.join("\n") };
  }
}
