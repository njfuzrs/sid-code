/**
 * Bundled Skill: /simplify
 *
 * 多代理并行代码审查：对已修改的代码启动三个并行审查代理
 * （复用性 / 质量 / 效率），汇总发现并修复。fork 模式执行。
 */

import { registerBundledSkill } from "./registry.ts";

const SIMPLIFY_PROMPT = `# Simplify: 代码审查与清理

你的任务是审查最近修改的代码，发现并修复复用性、质量、效率问题。

## 阶段 1: 识别变更
运行 \`git diff\` 和 \`git diff --staged\` 查看修改了什么。聚焦本次会话改动的文件。

## 阶段 2: 启动三个并行审查代理
使用 Agent 工具同时启动三个 explore 类型代理（并行，互不阻塞）：

### 代理 1: 代码复用审查
搜索项目中已有的工具函数、组件、模式，检查新写的代码是否重复造轮子。
重点：是否可以复用已有实现？是否引入了与现有约定不一致的新模式？

### 代理 2: 代码质量审查
检查 hacky 模式：冗余状态、参数膨胀、复制粘贴、过度抽象、命名不清、
缺少错误处理、与周围代码风格不一致。

### 代理 3: 效率审查
检查：不必要的计算、错过的并发机会、热路径上的冗余分配、
O(n²) 可降为 O(n) 的循环、可缓存却未缓存的重复工作。

## 阶段 3: 汇总与修复
等待三个代理完成。汇总发现，按"影响 × 确定性"排序，逐一修复。
修复后运行项目的构建/测试验证（参考 CLAUDE.md 的验证约定）。

## 阶段 4: 报告
简洁报告：发现了什么问题、修了哪些、哪些是建议但未修（附理由）。`;

export function registerSimplifySkill(): void {
  registerBundledSkill({
    name: "simplify",
    description: "审查已修改的代码，检查复用性、质量和效率问题，然后修复发现的问题",
    whenToUse: "当用户说 'review'、'simplify'、'检查代码'、'清理代码' 时",
    allowedTools: ["read", "write", "edit", "bash", "grep", "glob", "sub_agent"],
    context: "fork",
    userInvocable: true,
    maxTurns: 30,
    async getPromptForCommand(args) {
      return SIMPLIFY_PROMPT + (args.trim() ? `\n\n## 用户额外要求\n\n${args.trim()}` : "");
    },
  });
}
