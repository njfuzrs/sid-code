/**
 * Bundled Skill: /verify
 *
 * 验证代码变更是否按预期工作：运行类型检查、构建、相关测试，
 * 汇总结果。fork 模式执行，只读为主（除非需要修复明显的破坏）。
 */

import { registerBundledSkill } from "./registry.ts";

const VERIFY_PROMPT = `# Verify: 变更验证

你的任务是验证最近的代码变更是否按预期工作，不引入回归。

## 阶段 1: 识别变更范围
运行 \`git diff --stat\` 查看改动了哪些文件，判断影响面。

## 阶段 2: 确定验证手段
查看项目配置（package.json / Makefile / 等）确定可用的验证命令：
- 类型检查（如 tsc / bun 的类型检查）
- 构建（如 make build）
- 测试（如 bun test）
遵循 CLAUDE.md 的验证约定：优先跑相关单测；涉及编译产物时才跑完整构建。

## 阶段 3: 执行验证
按"快→慢"顺序执行：先类型检查/lint，再相关单测，必要时再完整构建。
记录每一步的实际输出，不要臆断结果。

## 阶段 4: 报告
如实报告：
- ✅ 通过的检查
- ❌ 失败的检查（附关键错误输出）
- 失败是否由本次变更引入（对比改动范围判断）

若发现明显由本次变更引入的破坏（如笔误、漏改的引用），可直接修复后重新验证。
不要为了"让测试通过"而削弱断言或跳过测试。`;

export function registerVerifySkill(): void {
  registerBundledSkill({
    name: "verify",
    description: "验证代码变更是否按预期工作（运行类型检查、构建、相关测试）",
    whenToUse: "当用户说 'verify'、'验证'、'检查是否工作'、'跑测试确认' 时",
    allowedTools: ["read", "bash", "grep", "glob", "edit"],
    context: "fork",
    userInvocable: true,
    maxTurns: 20,
    async getPromptForCommand(args) {
      return VERIFY_PROMPT + (args.trim() ? `\n\n## 用户额外要求\n\n${args.trim()}` : "");
    },
  });
}
