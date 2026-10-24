/**
 * 后台记忆提取提示词（Task 3）
 *
 * 提取代理通过 Forked Agent 已看到完整对话上下文，这里只需告诉它：
 * - 4 类封闭分类法
 * - 应该 / 不应该保存什么
 * - 保存步骤（用 save_memory 工具）
 * - 现有记忆清单（避免重复）
 * - type / scope 参数怎么填（只写 project，类型进 type）
 */

import { MEMORY_TYPE_DESCRIPTIONS } from "../types.ts";

/**
 * ⚠️ 这里**刻意没有** team scope 分流段（2026-10-24 移除）。
 *
 * 旧版在 `teamMemoryEnabled` 时追加一整段「满足条件就用 scope=team」，而
 * `extract/permissions.ts` 对后台代理的 save_memory 只放行 project——提示词主动引导
 * 模型去调一个**必然被拒**的工具，每次拒绝吃掉 3 次保存额度里的一次。
 *
 * 两边只能统一一个，选「权限层为准」：team 记忆会同步给全体协作者，误判代价是污染
 * 所有人的上下文且无人察觉，这需要人在场，而后台提取代理恰恰是无人监督的。
 * 团队约定由主会话（人在场）显式 `scope=team` 写入。别把分流段加回来，
 * 除非同时给权限层开一条带判据的 team 通道——否则就是把这个冲突原样复活。
 */

/** 构建提取提示词
 *
 * @param existingMemoriesManifest 现有记忆清单（避免重复保存）
 */
export function buildExtractPrompt(existingMemoriesManifest: string): string {
  const typeList = Object.entries(MEMORY_TYPE_DESCRIPTIONS)
    .map(([k, v]) => `- **${k}**: ${v}`)
    .join("\n");

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
- 已经存在于 CLAUDE.md 的规则
- 快照类清单（PR 列表、提交记录、活动日志）——即使用户说了"记住"，也只提炼其中非显而易见的那一点
- 调试过程与修复配方（修复已在代码与提交里）

## 保存步骤

1. 判断本轮对话是否有值得记住的新信息；没有就什么都不做
2. 对每条值得记住的信息，调用 save_memory 工具保存：
   - **type 必填**，填上面 4 类之一；reference 只用于外部系统指针（正文要有 URL），约定与决策用 feedback / project
   - **不要传 scope**：默认就是当前项目记忆，你也只能写这里；传 project 以外的任何值（含类型名）都会被拒
3. feedback / project 类记忆，在 value 里用行首的 **Why:** 和 **How to apply:** 两行写明理由与用法（缺了就别存）
4. 相对日期（今天、下周、上个月）改写成绝对日期 YYYY-MM-DD 再保存
5. 检查现有记忆清单，避免重复保存已有内容；如需更新，用清单里该条「key:」后的原值（不是文件名）

## 现有记忆清单

${existingMemoriesManifest}

## 不要验证（预算只够写，不够查）

你只有很少几轮。**只依据上面对话里已经出现的内容**判断与保存：
- 不要 grep / glob / read 项目源码去核实对话里的说法
- 不要跑 git 命令、不要查看提交历史
- 不要为了确认旧记忆是否仍然准确去读代码 —— 那是 autoDream 的职责
唯一允许的读取是现有记忆文件本身（为了用相同 key 更新它）。

## 约束

- 最多调用 save_memory 3 次（高信号优先）
- 没有值得保存的内容时，直接回复"无需保存"，不要强行编造
- 完成后简短说明保存了什么`;
}
