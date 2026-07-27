/**
 * 一次性脚手架脚本：生成阶段 5 待撰写页面的占位文件。
 *
 * 为什么现在就要建这些占位页：sidebar 已声明 36 个链接，而 VitePress 的
 * 死链检测是构建门禁（config.ts 的 ignoreDeadLinks: false）——页面不存在
 * 构建就失败。先把结构立起来，等阶段 5 逐篇替换内容。
 *
 * 用完即可删除（内容写完后本文件无保留价值）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/** [相对路径, 标题, 一句话说明（这页解决什么）, 对应 TODO 编号] */
const PAGES: Array<[string, string, string, string]> = [
  // ── L1 入门（start/index.md 由 T-0.2 单独写，不在此列）──
  ["start/install.md", "安装", "一条 curl 命令装好 sid-code，以及 PATH / 权限 / 架构识别三类常见失败的处理。", "T-5.2"],
  ["start/configure.md", "配置 LLM Provider", "anthropic / openai / ollama 三族协议各一份可直接粘的 settings.json，含 base_url 的 /v1 两族相反规则。", "T-5.2"],
  ["start/first-task.md", "跑通第一个任务", "一个真实小任务的全过程：改一个函数并跑测试，逐屏解说。", "T-5.2"],
  ["start/next.md", "接下来读什么", "按你的目标给出三条阅读路径，每条带一句为什么。", "T-5.2"],

  // ── L2 使用 ──
  ["use/interactive.md", "交互模式与键位", "常用键位、和弦、中断与排队输入的行为。", "T-5.4"],
  ["use/permissions.md", "权限与人工确认", "权限模式、允许/拒绝规则的写法，以及危险命令为什么会被拦。", "T-5.3"],
  ["use/sessions.md", "会话管理", "会话持久化、恢复（-c）、checkpoint 与回滚。", "T-5.4"],
  ["use/context.md", "上下文与压缩", "上下文窗口如何管理、auto-compact 何时触发、怎么少花 token。", "T-5.4"],
  ["use/plan-mode.md", "Plan Mode 与 Todo", "先规划后动手的用法，以及 todo 清单在长任务里的作用。", "T-5.4"],
  ["use/memory.md", "记忆与 CLAUDE.md", "项目指令、个人记忆、团队记忆三层的作用范围与优先级。", "T-5.4"],
  ["use/cost.md", "成本与用量", "单次任务花了多少、prompt cache 命中率怎么看、怎么把成本降下来。", "T-5.3"],
  ["use/worktree.md", "Worktree 隔离", "在独立 worktree 里干活，含 symlink node_modules 的跨分支 lockfile 风险。", "T-5.4"],
  ["use/troubleshooting.md", "排障", "真实踩过的坑：症状 → 原因 → 解法。", "T-5.4"],

  // ── L3 进阶定制 ──
  ["extend/index.md", "扩展方式总览", "Skill / Hook / 子代理 / MCP 四条扩展路径的选择表：什么场景用哪个。", "T-5.6"],
  ["extend/skills.md", "Skill", "把团队的流程与规范封装成可复用的 skill。", "T-5.6"],
  ["extend/hooks.md", "Hook 指南", "在关键节点插入自己的校验与自动化（任务导向；完整字段表见参考页）。", "T-5.3"],
  ["extend/subagents.md", "子代理", "把任务派给子代理，并按职责给子代理分级模型以省钱。", "T-5.3"],
  ["extend/mcp.md", "MCP", "接入 MCP server，把企业内部系统变成可调用的工具。", "T-5.6"],
  ["extend/lsp.md", "代码智能（LSP）", "定义跳转、引用查找、诊断注入如何让改代码更准。", "T-5.6"],
  ["extend/headless.md", "无头模式与脚本化", "在 CI / 脚本里非交互地跑 sid-code。", "T-5.6"],
  ["extend/plugins.md", "插件与 Bridge", "插件目录的加载规则与扩展边界。", "T-5.6"],

  // ── L4 参考（术语表是唯一人工页，其余 6 页由 docs-gen-reference.ts 生成）──
  ["ref/glossary.md", "术语表", "agentic loop / 上下文窗口 / 权限模式 / 轨迹 / effort 档位等术语的准确定义。", "T-5.5"],

  // ── L5 企业与团队 ──
  ["team/defaults.md", "团队默认配置分发", "用 team-defaults.json 给全团队统一 provider 与默认配置。", "T-5.7"],
  ["team/quota.md", "配额与成本控制", "按人/按团队设成本上限，以及超限时的行为。", "T-5.7"],
  ["team/policy.md", "企业 policy 与安全边界", "企业侧能强制约束哪些行为，以及当前的能力边界。", "T-5.7"],
  ["team/observability.md", "轨迹采集与可观测", "轨迹落在哪里、能回答什么问题、怎么聚合。", "T-5.7"],
  ["team/migrate.md", "从 Claude Code 迁移", "配置、hook、skill 的对应关系与迁移步骤。", "T-5.7"],
];

/** L4 的 6 页参考文档：内容由脚本生成，这里只建带 AUTO-GEN 标记的骨架 */
const REF_GENERATED: Array<[string, string, string, string]> = [
  ["ref/cli.md", "CLI 参数与子命令", "sid-code 的全部命令行参数与子命令。", "src/cli.ts parseArgs × src/help.ts 双源交叉对账"],
  ["ref/slash-commands.md", "斜杠命令", "交互模式里可用的全部斜杠命令。", "BUILTIN_COMMANDS + legacy 注册表"],
  ["ref/tools.md", "内置工具", "全部内置工具的名称、用途与入参。表里的名称就是你在权限规则、子代理工具清单、hook matcher 里要写的字符串。", "sid-code --dump-tools（运行时真值）"],
  ["ref/settings.md", "settings.json 字段", "settings.json 的全部可配字段、类型与默认值。", "SettingsSchema().shape + Config 接口"],
  ["ref/env.md", "环境变量", "全部可用环境变量及其作用。", "src/help.ts + 源码扫描"],
  ["ref/hooks.md", "Hook 事件", "全部 Hook 事件的名称、触发时机与载荷字段。", "HookEventName 枚举"],
];

const placeholder = (title: string, desc: string, todo: string) => `---
title: ${title}
description: ${desc}
---

# ${title}

::: warning 本页待撰写
内容排期在阶段 5（${todo}）。当前是占位页——先建出来是因为站点导航已声明这条链接，
而构建期死链检测是发布门禁（\`ignoreDeadLinks: false\`），页面缺失会直接让构建失败。
:::

${desc}

## 相关

- [sid-code 是什么](/start/)
- [安装](/start/install)
`;

const refSkeleton = (title: string, desc: string, source: string) => `---
title: ${title}
description: ${desc}
---

# ${title}

${desc}

::: danger 本页由脚本生成，请勿手工编辑
\`<!-- AUTO-GEN:START -->\` 与 \`<!-- AUTO-GEN:END -->\` 之间的内容由
\`scripts/docs-gen-reference.ts\` 从源码生成（数据源：${source}），
手改会在下次生成时被覆盖，且 pre-commit 会先拦住。

需要补充说明请写在标记**之外**——那部分内容会被保留。
:::

<!-- AUTO-GEN:START 由 scripts/docs-gen-reference.ts 生成，勿手工编辑 -->

_待生成（阶段 3 · T-3.3）。_

<!-- AUTO-GEN:END -->
`;

let n = 0;
for (const [rel, title, desc, todo] of PAGES) {
  const abs = join(ROOT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, placeholder(title, desc, todo), "utf8");
  n++;
}
for (const [rel, title, desc, source] of REF_GENERATED) {
  const abs = join(ROOT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, refSkeleton(title, desc, source), "utf8");
  n++;
}
console.log(`已生成 ${n} 个页面文件`);
