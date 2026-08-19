/**
 * EnterPlanMode 工具
 * AI 可主动调用进入 Plan Mode，也可由用户通过 /plan 命令触发
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import type { PlanModeManager } from "../plan/state.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const enterPlanModeSchema = lazySchema(() =>
  z.object({
    topic: z
      .string()
      .optional()
      .describe(
        "本次计划的中文主题，用于命名计划文件（如「重构认证模块」）。简短名词短语，10 字以内最佳。可省略。",
      ),
  }),
);

/**
 * 工具名混淆纠偏句。
 *
 * 2026-08-17 的事故形态：模型想创建隔离工作区（`enter_worktree`），但那个工具当时声明了
 * `shouldDefer=true`、不在本轮 schema 里，生成阶段坍缩成唯一共享 `enter_` 前缀的
 * `enter_plan_mode` —— 连续 5 次，每次先 `exit_plan_mode` 再 `enter_plan_mode`（所以
 * `isActive()` 恒 false、重入拦截恒不命中），产出 4 份无用 plan 文件，最后靠用户手动打断。
 *
 * 根因已在两处修掉（系统提示词按延迟分区 + worktree 工具改回首轮可见），本句是顺带的
 * **措辞纠偏**：把正确的下一步写进模型此刻正在读的那段文本，零新增机制、零误判风险。
 * 刻意**不做**"检测 enter/exit 振荡并阻断"那种外部防线 —— 本项目的启发式防线实测
 * 误判率≈100%（循环检测因此默认关闭），加防线不是修复。
 */
const WORKTREE_CONFUSION_HINT =
  "若你的意图是创建/进入隔离的 Git 工作区，要调的是 `enter_worktree`（本工具只切换计划模式，不创建工作区）。";

export class EnterPlanModeTool implements Tool {
  readonly zodSchema = enterPlanModeSchema();
  /** P2-3：模式切换类工具，进入计划模式是一次性状态跃迁，豁免循环检测 */
  readonly exemptFromLoopDetection = true;

  /**
   * 保留卡片、丢弃 `⎿` 正文（header 摘要用一句用户语言说明"进入了计划模式"）。
   *
   * 本工具的 `output` 是 `buildPlanModePrompt()` 的**整份 183 行计划模式引导**
   * （`## 计划模式已激活` / `### 阶段 1：理解需求` / `**决策记录（跨会话防漂移，重要）**` …）。
   * 按体积这是全仓库泄漏最严重的一处：一次模式切换在屏幕上打出上百行提示词。
   *
   * 对标 cc 的处理完全一致：`EnterPlanModeTool/UI.tsx` 的 `renderToolUseMessage()` 返 `null`、
   * `renderToolResultMessage()` **不渲染 prompt 正文**，只画两行用户语言：
   *   `● Entered plan mode` + 灰色 `Claude is now exploring and designing an implementation approach.`
   * 提示词本体只走 `mapToolResultToToolResultBlockParam` 那条模型侧出口。
   *
   * 不用 hidden：模式切换是**用户必须知道**的状态变化（它改变了后续所有写操作的可行性），
   * 且没有别处呈现，隐藏就是丢信息。
   */
  readonly resultDisplayMode = "summary" as const;

  constructor(private planManager: PlanModeManager) {}

  name(): string {
    return "enter_plan_mode";
  }

  description(): string {
    return `当任务的实现路径存在真实的模糊性，且先获得用户输入能避免大量返工时使用此工具。它将你切换到计划模式，在写代码前探索代码库、设计方案并获得用户审批。

## 何时使用

仅在以下情况使用 plan mode：

1. **真实架构歧义**: 存在多种合理方案，选择会实质性影响代码库
   - 例："给 API 加缓存" — Redis / 内存 / 文件，各有取舍
   - 例："加实时更新" — WebSocket / SSE / 轮询，选择不同架构走势不同

2. **需求不明确**: 必须先探索才能明确范围
   - 例："让应用变快" — 需要 profile 定位瓶颈
   - 例："重构这个模块" — 需要理解目标架构长什么样

3. **高风险重构**: 大幅改动现有结构，先对齐再动手降低风险
   - 例："重新设计认证系统"
   - 例："从状态管理方案 A 迁移到 B"

## 何时不使用

以下情况跳过 plan mode，直接开始：

- 即使涉及多文件，实现路径也很清晰
- 用户给的指令足够具体，实现方案显而易见
- 添加功能有明确的实现模式可遵循（如：加个按钮、遵循现有约定的新端点）
- 定位到根因后修复方案明确的 bug
- 纯研究/探索类任务
- 用户说"我们来搞 X"或"开始做 Y"这种「直接动手」口吻

**拿不准时，倾向于直接开始工作**，遇到具体选择点再问用户，而不是进一整套计划流程。

## 进入后的行为
1. 使用 read、grep、glob 工具探索代码库
2. 理解现有模式和架构
3. 设计实现方案
4. 将计划写入计划文件
5. 调用 exit_plan_mode 提交审批`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(enterPlanModeSchema()) as Record<string, unknown>;
  }

  readOnly(): boolean {
    return true;
  }

  async execute(input: unknown, _signal?: AbortSignal): Promise<ToolResult> {
    // 禁止在子代理上下文中进入 plan mode（防套娃）
    // 参考：Claude Code EnterPlanModeTool.ts:78-80
    const inp = input as Record<string, unknown> | undefined;
    if (inp?._agentId) {
      return {
        output:
          "子代理不能进入 plan mode。如需制定方案，请使用 sub_agent(type='plan') 委托子代理研究。",
        isError: true,
      };
    }

    if (this.planManager.isActive()) {
      // 措辞带纠偏信息：原文案只说状态（"已经在计划模式中"），不说"你想做的事该怎么做"，
      // 对模型没有信息量。见下方 confusionHint 的完整理由。
      return {
        output: `已经在计划模式中。${WORKTREE_CONFUSION_HINT}`,
        isError: true,
      };
    }

    const topic = typeof inp?.topic === "string" ? inp.topic : undefined;
    const ok = this.planManager.enter(undefined, topic);
    if (!ok) {
      return { output: "无法进入计划模式", isError: true };
    }

    // topic 缺失或明显无意义时，模型很可能并不是真想进计划模式 —— 实测那 5 次误触里
    // 有两次的 topic 直接是 `noop` / `noop2`（模型自己都没编出主题）。此时补一句纠偏。
    const topicLooksEmpty = !topic || topic.trim().length === 0 || /^noop\d*$/i.test(topic.trim());

    const planPath = this.planManager.getPlanFilePath();
    // 复活完整工作流引导（缺陷修复）：原先这段引导通过重建 system prompt 注入，
    // 重建逻辑删除后丢失。现作为 tool_result 返回——走消息通道不破坏 Prompt Caching，
    // 同时保留阶段 1-5 工作流、决策记录防漂移、以及回应用户的"不清空上下文"说明。
    const { existsSync } = await import("fs");
    const planExists = planPath ? existsSync(planPath) : false;
    const { buildPlanModePrompt } = await import("../plan/prompt.ts");
    const base = buildPlanModePrompt(planPath || "", planExists);
    return {
      output: topicLooksEmpty ? `${base}\n\n注意：${WORKTREE_CONFUSION_HINT}` : base,
    };
  }
}
