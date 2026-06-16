/**
 * Bundled Skill: /review
 *
 * 对当前变更 / 指定 diff 做 code review，输出结构化审查意见。
 *
 * 上下文模式：fork（子代理独立执行）。
 *   选 fork 的理由：审查是独立只读任务，不该污染主对话；fork 下 allowedTools
 *   真实生效，可把工具集锁定为只读（read/grep/glob/bash），契合 code-review 的
 *   RL-001"不删除用户代码"红线。
 *
 * 提示词复用策略（见补齐分析 §4.2 / §7.1）：
 *   command/review.ts 是 spawn 子进程的无头 CLI，运行模型与交互式斜杠命令不兼容，
 *   不复用其执行逻辑。这里复用的是"提示词资产"——直接取编译期嵌入的
 *   code-review SKILL.md 正文（EMBEDDED_BUILTIN_SKILLS），与无头 review 同一份提示词，
 *   保证两条路径的审查标准一致、不漂移。
 *
 * ⚠️ fork 限制（见 §4.3）：子代理看不到主对话，因此 prompt 明确要求它在用户
 *   没有显式给出 diff 时，自己用 git 命令取当前工作区/暂存区 diff。
 */

import { registerBundledSkill } from "./registry.ts";
import { getLogger } from "../../debug/logger.ts";

/**
 * 取 code-review SKILL.md 正文（去掉 YAML frontmatter）。
 * 失败时返回 null，由调用方降级到内联兜底提示词。
 */
async function loadCodeReviewBody(): Promise<string | null> {
  try {
    const { EMBEDDED_BUILTIN_SKILLS } = await import(
      "../builtin-embedded.generated.ts"
    );
    const entry = EMBEDDED_BUILTIN_SKILLS.find(
      (s: { name: string }) => s.name === "code-review",
    );
    if (!entry?.rawContent) return null;
    // 剥离开头的 YAML frontmatter（--- ... ---），只保留 Markdown 正文
    const body = entry.rawContent.replace(/^---\n[\s\S]*?\n---\n/, "");
    return body.trim() || null;
  } catch (err: any) {
    getLogger().debug(
      "SKILL",
      `加载 code-review 提示词资产失败，降级到内联兜底: ${err?.message}`,
    );
    return null;
  }
}

/** code-review 正文不可用时的内联兜底提示词（精简版，保持核心约束一致） */
const FALLBACK_REVIEW_PROMPT = `# Code Review

你负责对代码变更输出结构化审查意见，目标受众是 AI 生成代码场景下的开发者。

## 工作流程
1. 用 \`read\` 读取每个变更文件的完整内容（不只看 diff 片段）
2. 用 \`grep\`/\`glob\` 查找调用方、对应测试、相关配置
3. 按维度审查：正确性 / 安全性（凭证泄漏/注入/路径遍历）/ 测试覆盖 / 可读性 /
   设计 / AI 代码特征（编造 API、不存在的库、看似正确实则错误）/ 性能（N+1 等）

## 输出格式
- **Verdict**: approve / request_changes / block
- **Findings**: 按 severity 排序（blocker > high > medium > low），每条含 \`file:line\`
- **Test Coverage**: 哪些变更有/无测试覆盖

## 红线
- 只读 review，**不**调用 edit/write 改代码
- 每条 finding 必须**先 read 到该行原文**，再引用 \`file:line\`；禁止凭 diff/记忆编造位置
- findings 中不出现密钥/token 明文
- 宁可漏报不可误报：只报"会"出问题，不报"可能"`;

const REVIEW_HEADER = `# Review: 代码审查

你在一个**独立子会话**中运行，看不到主对话历史。审查目标 diff 的获取方式：

1. 如果用户在下方"用户额外要求"里给了 diff 文件路径或 commit range，用它
2. 否则自己取当前变更：
   - \`git diff --staged\`（已暂存改动）
   - 若暂存区为空，则 \`git diff HEAD\`（工作区改动）
   - 仍为空则 \`git diff main...HEAD\` 或 \`git diff master...HEAD\`（当前分支相对主干）
3. 取不到任何 diff 时，明确告知"未发现待审查的变更"，不要编造

下面是审查标准（复用 sid-code 内置 code-review skill 的提示词）：

---

`;

export function registerReviewSkill(): void {
  registerBundledSkill({
    name: "review",
    description: "对当前变更或指定 diff 做 code review，输出结构化审查意见",
    whenToUse:
      "当用户说 'review'、'代码审查'、'审一下'、'review 这个 PR'、'review 这次改动' 时",
    argumentHint: "[diff 文件路径 / commit range / 审查重点]",
    // fork 模式：白名单真实生效，锁定只读工具（对齐 code-review RL-001）
    allowedTools: ["read", "grep", "glob", "bash"],
    context: "fork",
    userInvocable: true,
    maxTurns: 30,
    async getPromptForCommand(args) {
      const body = (await loadCodeReviewBody()) ?? FALLBACK_REVIEW_PROMPT;
      const extra = args.trim()
        ? `\n\n---\n\n## 用户额外要求\n\n${args.trim()}`
        : "";
      return REVIEW_HEADER + body + extra;
    },
  });
}
