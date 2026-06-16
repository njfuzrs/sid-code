/**
 * Bundled Skill: /commit-push-pr
 *
 * 在 commit 基础上扩展：提交 → 推送到远端 → 创建 PR（gh pr create）。
 *
 * 上下文模式：fork（子代理独立执行）。
 *   选 fork 的理由：这是一条多步骤的长流程（commit + push + 建 PR），独立执行
 *   不污染主对话；且 fork 下 allowedTools 真实生效（见 sub-agent.ts:352-355），
 *   可把工具集锁定在 git/gh/读写范围内。
 *
 * ⚠️ fork 限制（见补齐分析 §4.3）：
 *   (1) 子代理看不到主对话上下文——用户在主对话里"刚改了什么、想强调什么"，
 *       子代理拿不到。因此 prompt 明确要求它先 git status/diff 自查工作区。
 *   (2) systemPrompt 写死为通用助手提示——本 skill 的约束只能写进下方 userPrompt。
 */

import { registerBundledSkill } from "./registry.ts";

const COMMIT_PUSH_PR_PROMPT = `# Commit-Push-PR: 提交 → 推送 → 创建 PR

你是一个 Git/PR 流程助手。你在一个**独立子会话**中运行，看不到主对话历史，
所有当前状态都必须自己用 git 命令查清楚。按以下阶段顺序执行，每阶段完成后简报进展。

## 阶段 1: 摸清工作区状态
1. \`git status\` —— 当前分支、已暂存/未暂存/未跟踪文件
2. \`git diff --staged\` 和 \`git diff\` —— 看清要提交的内容
3. \`git log --oneline -10\` —— 参考已有 commit message 风格
4. \`git branch --show-current\` —— 确认当前分支名

## 阶段 2: 提交
1. 若暂存区为空但有改动，按需 \`git add\` 相关文件（不要 \`git add -A\` 吞入无关文件；
   不确定时只 add 明显属于本次改动的文件）
2. 按 conventional commits 规范生成 message（\`<type>(<scope>): <subject>\`，
   type ∈ feat/fix/chore/docs/refactor/test/perf；语言跟随仓库历史）
3. 执行 \`git commit\`

## 阶段 3: 推送
1. **安全约束**：不要直接推到 main/master。若当前在 main/master，先创建特性分支
   （如 \`git checkout -b <type>/<short-desc>\`）再推
2. \`git push -u origin HEAD\` 推送当前分支并建立 upstream 跟踪

## 阶段 4: 创建 PR
1. 先确认 \`gh\` CLI 可用（\`gh --version\`）；不可用则提示用户安装/登录 gh，并给出
   手动创建 PR 的链接，流程到此为止
2. \`gh pr create\` 创建 PR：
   - 标题简洁（≤70 字符），承接 commit 主题
   - 正文包含：变更摘要 / 测试情况 / 受影响范围
   - 目标分支通常是 main/master（用 \`gh repo view\` 确认默认分支）
3. 输出 PR 链接

## 阶段 5: 报告
汇总：提交了什么 commit、推到了哪个分支、PR 链接。

## 红线约束
- 绝不 \`git push --force\` / \`reset --hard\` / 删分支等破坏性操作
- 绝不直接推送 main/master
- 提交前若发现疑似密钥文件（.env / *.key / credentials），停下来警示，不要提交
- 不修改与本次提交无关的代码`;

export function registerCommitPushPrSkill(): void {
  registerBundledSkill({
    name: "commit-push-pr",
    description: "提交变更、推送到远端并创建 PR(gh pr create)的完整流程",
    whenToUse:
      "当用户说 'commit push pr'、'提交并发 PR'、'推送并创建 PR'、'一键发 PR' 时",
    argumentHint: "[PR 标题或额外说明]",
    // fork 模式：以下白名单真实生效
    allowedTools: ["bash", "read", "grep", "glob"],
    context: "fork",
    userInvocable: true,
    maxTurns: 25,
    async getPromptForCommand(args) {
      return (
        COMMIT_PUSH_PR_PROMPT +
        (args.trim() ? `\n\n## 用户额外要求\n\n${args.trim()}` : "")
      );
    },
  });
}
