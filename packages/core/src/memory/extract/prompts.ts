/**
 * 后台记忆提取提示词（Task 3）
 *
 * 提取代理通过 Forked Agent 已看到完整对话上下文，这里只需告诉它：
 * - 4 类封闭分类法
 * - 应该 / 不应该保存什么
 * - 保存步骤（用 save_memory 工具）
 * - 现有记忆清单（避免重复）
 * - scope 分流（仅在团队记忆启用时，允许把明确的团队级约定沉淀到 team scope）
 */

import { MEMORY_TYPE_DESCRIPTIONS } from "../types.ts";

/**
 * 团队 scope 分流指引（对标 claude-code memoryTypes.ts 的 <scope> 规则，但**更保守**）。
 *
 * claude-code 的默认是 `project` 型 "strongly bias toward team"、`reference` 型 "usually team"。
 * 我们没有 claude-code 那样的海量用户数据来校准「什么该自动进团队」，自动写团队会
 * 同步给所有协作者，误判的代价是污染全团队上下文且无人察觉。因此初期采取**比
 * claude-code 更高的门槛**：默认一律私有，仅当事实**显然是**项目级团队约定
 * （编码规范 / 架构决策 / PR 流程 / 团队工具链约定）且**不含任何个人偏好成分**时，
 * 才允许 scope=team。存疑一律走私有。
 */
function buildTeamScopeSection(): string {
  return `## 记忆范围（scope）分流

本会话已启用团队记忆。save_memory 支持 scope 参数：
- **不传 scope（默认）**：保存为私有记忆，只有你自己可见。
- **scope=team**：保存为团队共享记忆，会同步给所有协作者。

**团队 scope 判定（从严，存疑走私有）**：只有当这条信息**同时满足**以下全部条件时，才用 scope=team：
1. 它是**项目级团队约定**——编码规范、架构决策、PR / 提交流程、团队统一的工具链或目录约定；
2. 它对**任何协作者都成立**，不掺杂"这个用户个人的"偏好、习惯或角色信息；
3. 你有**明确证据**（用户在对话里把它表述为团队规则 / 项目规范），而非你的推测。

只要有一条不满足，或你有任何犹豫，就**保存为私有**（不传 scope）。宁可漏判进私有，
绝不误判进团队——团队记忆污染会影响所有人且难以察觉。

**永远不要**自动写入 team scope 的内容：
- user 类（用户画像 / 个人偏好 / 角色）——永远私有；
- 任何含 secret 的内容（team scope 会被 secret 守卫拒绝，且会浪费一次调用）；
- 你不确定是否团队通用的任何事实。`;
}

/** 构建提取提示词
 *
 * @param existingMemoriesManifest 现有记忆清单（避免重复保存）
 * @param teamMemoryEnabled        是否启用团队记忆——启用时追加 team scope 保守分流指引
 */
export function buildExtractPrompt(
  existingMemoriesManifest: string,
  teamMemoryEnabled = false,
): string {
  const typeList = Object.entries(MEMORY_TYPE_DESCRIPTIONS)
    .map(([k, v]) => `- **${k}**: ${v}`)
    .join("\n");

  const teamScopeSection = teamMemoryEnabled ? `\n\n${buildTeamScopeSection()}` : "";

  return `你是后台记忆提取代理。回顾上面的对话，提取值得长期记住的信息并保存。

## 记忆类型（封闭分类法，只能用这 4 种）

${typeList}

## 应该保存的内容

- 用户的长期偏好、编码风格、工作习惯
- 用户对你的明确纠正与确认（feedback 类，必须记录 Why）
- 无法从代码推导的项目上下文、决策、约束
- 外部系统的引用（URL、dashboard、ticket）

## 不应该保存的内容

- 可以从代码、git 历史、文件内容直接推导的事实
- 临时性的会话状态、当前任务进展（这些归 Session Memory）
- 敏感信息（API Key、token、密码）—— 绝对不要保存凭证明文
- 已经存在于 CLAUDE.md 的规则${teamScopeSection}

## 保存步骤

1. 判断本轮对话是否有值得记住的新信息；没有就什么都不做
2. 对每条值得记住的信息，调用 save_memory 工具保存
3. feedback / project 类记忆，在 value 里附上 **Why** 和 **How to apply**
4. 检查现有记忆清单，避免重复保存已有内容；如需更新，用相同的 key

## 现有记忆清单

${existingMemoriesManifest}

## 约束

- 最多调用 save_memory 3 次（高信号优先）
- 没有值得保存的内容时，直接回复"无需保存"，不要强行编造
- 完成后简短说明保存了什么`;
}
