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

你的任务是基于当前 git 变更，生成规范的 commit message 并完成提交。

## 阶段 1: 查看变更
1. 运行 \`git status\` 了解工作区状态（哪些已暂存、哪些未暂存、哪些未跟踪）
2. 运行 \`git diff --staged\` 查看暂存区变更
3. 如果暂存区为空但有未暂存变更，提示用户：当前没有已暂存的改动，是否需要先 \`git add\`（不要擅自 \`git add -A\` 把无关文件也提交进去）
4. 运行 \`git log --oneline -10\` 参考本仓库已有的 commit message 风格

## 阶段 2: 生成 commit message
按 **conventional commits** 规范生成：
- 格式：\`<type>(<scope>): <subject>\`
- type 取值：feat / fix / chore / docs / refactor / test / perf / style / build / ci
- scope 可选；涉及多模块时建议标明
- subject 用祈使句、简明扼要；与本仓库历史 commit 的语言保持一致（中文仓库写中文）
- 改动复杂时，在 body 里补充"做了什么 / 为什么"，每行不超过 72 字符

## 阶段 3: 确认后提交
1. 把生成的 commit message **完整展示**给用户
2. 等用户确认（或要求调整）后，再执行 \`git commit -m "..."\`
3. **不要**自动 \`git push\`——推送是 /commit-push-pr 的职责
4. 提交后运行 \`git log --oneline -1\` 回显结果

## 约束
- 只提交已暂存的内容；不擅自扩大提交范围
- 不修改任何代码文件，只生成 message 并提交
- 如发现暂存区疑似包含密钥文件（.env / credentials / *.key 等），先警示用户再继续`;

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
    async getPromptForCommand(args) {
      return (
        COMMIT_PROMPT +
        (args.trim() ? `\n\n## 用户额外要求\n\n${args.trim()}` : "")
      );
    },
  });
}
