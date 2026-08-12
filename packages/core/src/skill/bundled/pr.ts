/**
 * Bundled Skill: /pr
 *
 * 分析当前分支相对基线分支的所有 commit + 累计 diff，生成一份高质量 PR 描述
 * （标题 + 结构化正文）。对齐 claude-code /pr（研究文档 §4.4）。
 *
 * 上下文模式：inline（在当前对话内执行）。
 *   选 inline 的理由：/pr 的产物是"给人看的 PR 描述文本"，用户需要在对话里看到、
 *   复制或让 AI 据其反馈微调；fork 子代理看不到主对话也不便交互。
 *
 * 职责边界（与其它 Git/PR 命令区分，避免功能重叠）：
 *   - /commit          —— 只生成 commit message 并提交，不推送。
 *   - /commit-push-pr  —— 提交 + 推送 + 建 PR 全链路（一键走完）。
 *   - /pr（本命令）    —— 只"生成 PR 描述"：分析 commit 汇总成标题+正文，
 *                          默认不提交、不推送、不建 PR。用户可拿去手动建 PR，
 *                          或让 AI 接着调 gh 创建（需用户明确要求）。
 *
 * ⚠️ inline 模式下 allowedTools 不生效（见 commit.ts 头注释），此处仅作意图声明；
 *   真正的安全边界靠 prompt 行为约束 + 主会话 Permission 系统。
 */

import { registerBundledSkill } from "./registry.ts";

const PR_PROMPT = `# PR: 生成 Pull Request 描述

分析当前分支的变更，产出一份**可直接粘贴到 PR 的描述**（标题 + 正文）。
核心职责是**生成描述文本**，默认不提交、不推送、不建 PR。

## 阶段 1: 摸清变更范围（并行跑，输出简明）
并行运行以下命令，不要逐条复述原始输出，只记结论：
- \`git branch --show-current\`：当前分支名
- \`git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null\`：上游分支（可能无）
- 推断基线分支：优先 origin/main、其次 origin/master（用 \`git rev-parse --verify\` 探测存在性）
- \`git log --oneline <base>..HEAD\`：本分支相对基线的所有 commit
- \`git diff <base>...HEAD --stat\`：累计变更文件与规模
- 需要看细节时再 \`git diff <base>...HEAD\`（大 diff 只看关键文件）

若探测不到基线分支或当前就在 main/master，改为分析最近若干 commit（\`git log --oneline -10\`），
并在开头提示"未识别到基线分支，基于最近提交生成，请人工核对范围"。

## 阶段 2: 生成 PR 描述
输出以下结构（**用代码块完整展示**，便于用户整段复制）：

\`\`\`markdown
<标题：简洁祈使句，≤70 字符，遵循仓库 commit 风格（中文仓库写中文）>

## 变更摘要
<3-6 条要点，说清这个 PR 做了什么、为什么>

## 主要改动
<按模块/文件分组列出关键改动，附一句意图说明>

## 测试情况
<列出已跑的测试/构建；若无法确认则写"待补"并提示用户补充>

## 影响范围 / 风险
<对外行为变化、破坏性变更、需要迁移的点；无则写"无">
\`\`\`

## 约束
- **只生成描述**：默认不 \`git add\` / \`git commit\` / \`git push\` / \`gh pr create\`。
  用户如需你接着提交或建 PR，会明确说——那属于 /commit 或 /commit-push-pr 的职责。
- 标题控制在 70 字符内；正文分节清晰，不堆砌命令原始输出。
- 测试情况不要编造：只写你**确实**从 git 历史/对话里看到的，没有就标"待补"。
- 全程简洁：不复述 diff 全文，聚焦"讲清楚这个 PR"。`;

export function registerPrSkill(): void {
  registerBundledSkill({
    name: "pr",
    description: "分析当前分支的 commit 与 diff，生成 PR 标题与结构化描述",
    whenToUse: "当用户说 '生成 PR 描述'、'写个 PR'、'pr description'、'总结这个分支的改动发 PR' 时",
    argumentHint: "[基线分支或额外要求]",
    // inline 模式下以下白名单不生效，仅作意图声明（见 commit.ts 头注释）
    allowedTools: ["bash", "read", "grep", "glob"],
    context: "inline",
    userInvocable: true,
    async getPromptForCommand(args, context) {
      // P3-1：PR 归因动态注入（settings.git.prAttribution）。
      // /pr 只产出描述文本不建 PR，但产出会被用户直接拿去建 PR，归因同样要带上；
      // prAttribution.enabled=false → 空串 → prompt 里完全不提归因。
      const { prAttributionInstruction } = await import("../../tool/git-attribution.ts");
      const prAttr = prAttributionInstruction(context?.config?.git);
      return (
        PR_PROMPT +
        (prAttr ? `\n\n## 归因\n${prAttr}` : "") +
        (args.trim() ? `\n\n## 用户额外要求\n\n${args.trim()}` : "")
      );
    },
  });
}
