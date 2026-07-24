/**
 * Bundled Skill: /commit
 *
 * AI 读取 git diff，生成符合 conventional commits 规范的 commit message 并提交。
 *
 * 上下文模式：inline（在当前对话内执行）。
 *   选 inline 的理由：用户需要在对话里看到并确认生成的 commit message 再提交，
 *   fork 子代理看不到主对话、也不便交互确认。
 *
 * ⚠️ 重要约束：inline 模式下 allowedTools 完全不生效（被执行引擎忽略，见
 *   src/command/executor.ts:204-215 与本批次补齐分析 §3.3）。下方 allowedTools
 *   仅作"意图声明 + 未来切 fork 时复用"，真正的安全边界靠：
 *     (1) 下方 prompt 的行为约束（展示 message → 用户确认 → 才 commit）；
 *     (2) 主会话本身的 Permission 系统（危险 git 操作会触发确认）。
 *   这与 claude-code 的 /commit 一致：它也是 inline 跑在主会话、靠权限系统兜底。
 */

import { registerBundledSkill } from "./registry.ts";

const COMMIT_PROMPT = `# Commit: 生成提交信息并提交

基于当前 git 变更生成规范 commit message 并提交。**追求快捷**：能推断的就直接做，
需要用户拍板的岔路口一律用 \`ask_user_question\` 工具弹结构化选项，不要在正文里写一段
问话等用户自由回答（那样用户还得手敲第二遍，慢且啰嗦）。

## 阶段 1: 查看变更（并行跑，输出简明）
并行运行以下命令摸清状态，不要逐条复述输出，只在心里记住结论：
- \`git status\`：哪些已暂存 / 未暂存 / 未跟踪
- \`git diff --staged\`：暂存区变更
- \`git diff\`：未暂存变更（暂存区为空时据此判断该 add 什么）
- \`git log --oneline -10\`：参考本仓库 commit 风格与语言

## 阶段 2: 处理暂存区（暂存区为空时）
若暂存区为空但有改动，用 \`ask_user_question\` 让用户选如何暂存（不要擅自 \`git add -A\`
吞入无关文件）。给出类似选项：
- "暂存全部改动"（列出将 add 的文件）
- "只暂存本次相关文件"（你判断出的相关文件）
- "手动指定"（让用户补充）
按用户选择执行 \`git add\`。若暂存区已非空，跳过本阶段。

## 阶段 3: 生成 commit message
按 **conventional commits** 规范：
- 格式：\`<type>(<scope>): <subject>\`，type ∈ feat/fix/chore/docs/refactor/test/perf/style/build/ci
- scope 可选，多模块时标明；subject 用祈使句、简明；语言跟随仓库历史（中文仓库写中文）
- 改动复杂时 body 补"做了什么 / 为什么"，每行 ≤72 字符

## 阶段 4: 确认后提交
先把生成的 message 用代码块**完整展示**一次，紧接着用 \`ask_user_question\` 让用户拍板，
选项固定为：
- "确认提交"（推荐）
- "调整信息"（选后请用户说明怎么改，改完再走一次本阶段确认）
- "取消"（放弃提交，流程结束）
用户选"确认提交"才执行 \`git commit\`；选"取消"则不提交并简报"已取消"。
提交后运行 \`git log --oneline -1\` 回显结果。

## 阶段 5: pre-commit hook 失败处理（关键）
若 git commit 因 pre-commit hook 失败（lint/test 未过）：
- **commit 没有发生**。此时绝不能用 \`git commit --amend\`——amend 会改掉「上一个已完成的
  commit」，可能破坏历史工作。
- 正确做法：修复 hook 报告的问题 → 重新 \`git add\` 相关文件 → 创建一个**新的** \`git commit\`。
- 除非用户明确要求 amend，否则始终新建 commit。

## 约束
- 只提交已暂存内容，不擅自扩大范围；不修改任何代码文件，只生成 message 并提交
- **不要**自动 \`git push\`——推送是 /commit-push-pr 的职责
- 若暂存区疑似含密钥文件（.env / credentials / *.key 等），先用 \`ask_user_question\`
  警示并让用户确认是否继续，再往下走
- 全程保持简洁：不复述命令原始输出，不写长表格，把交互交给 ask_user_question`;

export function registerCommitSkill(): void {
  registerBundledSkill({
    name: "commit",
    description: "读取 git diff，生成 conventional commits 规范的提交信息并提交",
    whenToUse:
      "当用户说 'commit'、'提交代码'、'生成提交信息'、'帮我 commit' 时",
    argumentHint: "[额外要求，如 scope 或语言]",
    // inline 模式下以下白名单不生效，仅作意图声明（见文件头注释）
    allowedTools: ["bash", "read", "grep", "glob"],
    context: "inline",
    userInvocable: true,
    async getPromptForCommand(args, context) {
      // P3-1：归因动态注入（settings.git.commitAttribution），覆盖所有 commit 路径。
      // enabled=false → 空串 → prompt 不出现归因指令（对齐 CC shouldIncludeGitInstructions）。
      const { commitAttributionInstruction } = await import("../../tool/git-attribution.ts");
      const attribution = commitAttributionInstruction(context?.config?.git);
      const attributionSection = attribution ? `\n\n## 归因\n${attribution}` : "";
      return (
        COMMIT_PROMPT +
        attributionSection +
        (args.trim() ? `\n\n## 用户额外要求\n\n${args.trim()}` : "")
      );
    },
  });
}
