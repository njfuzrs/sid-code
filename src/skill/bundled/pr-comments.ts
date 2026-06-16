/**
 * Bundled Skill: /pr-comments（别名 /pr_comments）
 *
 * 读取 PR 上的 reviewer 评论，逐条处理：需要改代码的直接改，需要回复的生成回复。
 *
 * 命名：sid 内置 skill 用 kebab-case（code-review / commit-push-pr），故主名为
 *   pr-comments；同时挂 pr_comments 别名，兼容 claude-code 的下划线命名与补齐
 *   分析中 /pr_comments 的写法（findCommand 支持别名查找，见 unified-registry.ts）。
 *
 * 上下文模式：fork（子代理独立执行）。
 *   选 fork 的理由：处理评审意见可能多轮改代码 + 回复，独立执行不污染主对话；
 *   需要 write/edit 权限，fork 下 allowedTools 真实生效可控制范围。
 *
 * ⚠️ fork 限制（见补齐分析 §4.3）：子代理看不到主对话，PR 信息全靠 gh 命令自取。
 */

import { registerBundledSkill } from "./registry.ts";

const PR_COMMENTS_PROMPT = `# PR-Comments: 处理 PR 评审意见

你是一个 PR 评审反馈处理助手，在**独立子会话**中运行，看不到主对话历史。
任务：读取 PR 上的 reviewer 评论，逐条分析并处理。

## 阶段 1: 定位 PR 与拉取评论
1. 先确认 \`gh\` CLI 可用（\`gh --version\`）；不可用则提示用户安装/登录 gh，流程终止
2. 确定目标 PR：
   - 用户在"额外要求"里给了 PR 编号/URL → 用它
   - 否则用 \`gh pr view\` 取当前分支关联的 PR
3. 拉取评论：
   - \`gh pr view <pr> --comments\` —— PR 主线评论
   - \`gh api repos/{owner}/{repo}/pulls/<pr>/comments\` —— 行级 review 评论（含 file/line）
   - 整理成一份"待处理评论清单"：每条含 评论者 / 位置(file:line 若有) / 诉求

## 阶段 2: 逐条分析归类
对每条评论判断类型：
- **需改代码**：reviewer 指出 bug / 要求重构 / 提改进建议且合理
- **需回复澄清**：reviewer 提问 / 误解了代码意图 / 建议不采纳需说明理由
- **可忽略**：纯肯定（"LGTM"）/ 已过时（代码已改）

## 阶段 3: 改代码
对"需改代码"的评论：
1. 用 \`read\` 读到评论指向的实际代码（先读原文，别凭评论摘要臆改）
2. 用 \`edit\` 做最小化修改，只改评论点名的问题，不顺手重构无关代码
3. 改完用项目的构建/测试验证（参考 CLAUDE.md 验证约定）

## 阶段 4: 生成回复
对每条评论生成得体的回复草稿：
- 采纳的：简述怎么改的 + 引用 commit/file:line
- 不采纳的：礼貌说明理由，对事不对人
- 提问的：直接回答
> 默认**只生成回复内容供用户审阅**；除非用户明确要求，不自动 \`gh pr comment\` 发布回复

## 阶段 5: 报告
汇总：共 N 条评论 → 改了哪几条（附 file:line）/ 回复了哪几条（附草稿）/ 忽略哪几条（附理由）。
若做了代码修改，提示用户："修改已完成，可用 /commit-push-pr 提交并更新 PR"。

## 红线约束
- 改代码必须先 read 到原文，禁止凭评论文字盲改
- 不自动发布评论回复（除非用户显式要求）
- 不做与评审意见无关的改动
- 不为"让 CI 过"而削弱测试断言`;

export function registerPrCommentsSkill(): void {
  registerBundledSkill({
    name: "pr-comments",
    aliases: ["pr_comments"],
    description: "读取 PR 上的 reviewer 评论，逐条处理(改代码 / 生成回复)",
    whenToUse:
      "当用户说 'pr comments'、'处理评审意见'、'回复 PR 评论'、'reviewer 提的意见' 时",
    argumentHint: "[PR 编号或 URL]",
    // fork 模式：白名单真实生效（含 edit/write 以便改代码）
    allowedTools: ["bash", "read", "grep", "glob", "edit", "write"],
    context: "fork",
    userInvocable: true,
    maxTurns: 30,
    async getPromptForCommand(args) {
      return (
        PR_COMMENTS_PROMPT +
        (args.trim() ? `\n\n## 用户额外要求\n\n${args.trim()}` : "")
      );
    },
  });
}
