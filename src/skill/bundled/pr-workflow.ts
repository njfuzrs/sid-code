/**
 * Bundled Skill: /pr-workflow（meta-skill / SOP）
 *
 * 完整 PR 工作流的标准作业流程（SOP）：提交 → 推送 → 创建 PR → 自审 → 处理评审意见。
 * 这是补齐分析 §5.1 的"方式 A：meta-skill"——一个 Skill 即一个 SOP，用户输入
 * /pr-workflow 一键按阶段顺序走完整条链路。
 *
 * 上下文模式：fork（子代理独立执行）。
 *   选 fork 的理由：长流程多步骤，独立执行不污染主对话；allowedTools 真实生效。
 *
 * ⚠️ 轮次/超时上限（见 §5.1 与 skill/types.ts:51-54）：
 *   maxTurns 最大 50、timeoutMins 最大 30（写超会被钳到上限）。这里取满。
 *   一条走完五阶段的 SOP，光逐文件自审就可能吃掉十几轮——50 轮可能不够。
 *   因此 prompt 里明确要求：自审阶段聚焦"本次变更引入的高风险点"，不做地毯式逐行
 *   通读；若变更体量大、轮次吃紧，优先保证"提交+发 PR"完成，自审降级为概要提示，
 *   并建议用户对发出的 PR 单独跑 /review 做完整审查。
 *
 * ⚠️ fork 限制（见 §4.3）：子代理看不到主对话，工作区状态全靠 git 自查。
 */

import { registerBundledSkill } from "./registry.ts";

const PR_WORKFLOW_PROMPT = `# PR 工作流 SOP

你是一个完整的 PR 工作流助手，在**独立子会话**中运行，看不到主对话历史——
当前工作区状态必须自己用 git 命令查清楚。按以下阶段**顺序执行**，每个阶段完成后
报告进展再进入下一阶段。

> ⚠️ 轮次预算：你最多 50 轮、30 分钟。请精打细算——优先保证"提交 + 发 PR"这两个
> 不可逆/对外的关键动作完成。若变更体量大导致轮次吃紧，自审（阶段 4）降级为
> "高风险点概要 + 建议用户对该 PR 单独跑 /review"，不要因为逐行通读而耗尽轮次
> 导致 PR 没发出去。

## 阶段 1: 摸清工作区
1. \`git status\` / \`git branch --show-current\` —— 当前分支与改动状态
2. \`git diff --staged\` 和 \`git diff\` —— 看清要提交的内容
3. \`git log --oneline -10\` —— 参考已有 commit message 风格

## 阶段 2: 提交
1. 按需 \`git add\` 相关文件（不 \`git add -A\` 吞入无关文件）
2. 生成 conventional commits 规范的 message（\`<type>(<scope>): <subject>\`，
   type ∈ feat/fix/chore/docs/refactor/test/perf；语言跟随仓库历史）
3. \`git commit\`

## 阶段 3: 推送 + 创建 PR
1. **安全约束**：不直接推 main/master。若当前在 main/master，先切特性分支
2. \`git push -u origin HEAD\`
3. 确认 \`gh\` 可用后 \`gh pr create\`：标题简洁(≤70 字符)、正文含变更摘要/测试情况/影响范围
4. 输出 PR 链接（gh 不可用则给出手动创建 PR 的提示并说明流程到此为止）

## 阶段 4: 自审（带预算意识）
按 sid-code code-review 的标准审查本次变更，**聚焦变更引入的高风险点**：
- 正确性（边界 / null / 异常处理）、安全性（凭证泄漏 / 注入 / 路径遍历）
- AI 代码特征（编造 API / 不存在的库 / 看似正确实则错误）、明显性能问题
输出结构化审查意见：每条 finding 带 \`file:line\`，按 severity 排序。
> 这是只读自审，不在此阶段改代码。轮次紧张时只列高风险点并建议用户单独跑 /review。

## 阶段 5: 处理评审意见（按需）
若用户在"额外要求"里提供了 reviewer 评论（或要求拉取已有 PR 评论）：
1. 逐条分析归类（需改代码 / 需回复 / 可忽略）
2. 需改代码的：先 read 原文再 edit 最小化修改，改后验证构建/测试
3. 需回复的：生成回复草稿（默认不自动发布）
4. 改完可重新 \`git push\` 更新 PR
若用户未提供评审意见，本阶段跳过，提示用户"PR 已创建，收到 reviewer 评论后可用
/pr_comments 处理"。

## 完成报告
输出整个流程摘要：提交了什么 / 推到哪个分支 / PR 链接 / 自审发现的高风险点 /
处理了哪些评论（如有）。

## 红线约束
- 绝不破坏性 git 操作（force push / reset --hard / 删分支）
- 绝不直接推 main/master
- 提交前发现疑似密钥文件（.env / *.key / credentials）立即停下警示
- 改代码必先 read 原文；不为"让 CI 过"削弱测试断言
- 不自动发布 PR 评论回复（除非用户显式要求）`;

export function registerPrWorkflowSkill(): void {
  registerBundledSkill({
    name: "pr-workflow",
    description:
      "完整 PR 工作流 SOP：提交 → 推送 → 创建 PR → 自审 → 处理评审意见(一键走完)",
    whenToUse:
      "当用户说 'pr workflow'、'走完整 PR 流程'、'一键提交发 PR 并审查'、'PR SOP' 时",
    argumentHint: "[PR 说明 / reviewer 评论 / 额外要求]",
    // fork 模式：白名单真实生效（含 edit/write 以便阶段 5 改代码）
    allowedTools: ["bash", "read", "grep", "glob", "edit", "write"],
    context: "fork",
    userInvocable: true,
    // 强副作用(push + 建 PR + 改代码)：禁止模型自动调用，仅用户显式 /pr-workflow 触发
    disableModelInvocation: true,
    maxTurns: 50, // 上限（skill/types.ts:51）
    timeoutMins: 30, // 上限：五阶段 SOP 含 push/建 PR + 自审，2 分钟远不够
    async getPromptForCommand(args) {
      return (
        PR_WORKFLOW_PROMPT +
        (args.trim() ? `\n\n## 用户额外要求\n\n${args.trim()}` : "")
      );
    },
  });
}
