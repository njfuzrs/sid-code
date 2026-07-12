/**
 * EnterPlanMode 工具
 * AI 可主动调用进入 Plan Mode，也可由用户通过 /plan 命令触发
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import type { PlanModeManager } from "../plan/state.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const enterPlanModeSchema = lazySchema(() => z.object({}));

export class EnterPlanModeTool implements Tool {
  readonly zodSchema = enterPlanModeSchema();
  /** P2-3：模式切换类工具，进入计划模式是一次性状态跃迁，豁免循环检测 */
  readonly exemptFromLoopDetection = true;

  constructor(private planManager: PlanModeManager) {}

  name(): string { return "enter_plan_mode"; }

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

  readOnly(): boolean { return true; }

  async execute(input: unknown, _signal?: AbortSignal): Promise<ToolResult> {
    // 禁止在子代理上下文中进入 plan mode（防套娃）
    // 参考：Claude Code EnterPlanModeTool.ts:78-80
    const inp = input as Record<string, unknown> | undefined;
    if (inp?._agentId) {
      return {
        output: "子代理不能进入 plan mode。如需制定方案，请使用 sub_agent(type='plan') 委托子代理研究。",
        isError: true,
      };
    }

    if (this.planManager.isActive()) {
      return { output: "已经在计划模式中", isError: true };
    }

    const ok = this.planManager.enter();
    if (!ok) {
      return { output: "无法进入计划模式", isError: true };
    }

    const planPath = this.planManager.getPlanFilePath();
    // 复活完整工作流引导（缺陷修复）：原先这段引导通过重建 system prompt 注入，
    // 重建逻辑删除后丢失。现作为 tool_result 返回——走消息通道不破坏 Prompt Caching，
    // 同时保留阶段 1-5 工作流、决策记录防漂移、以及回应用户的"不清空上下文"说明。
    const { existsSync } = await import("fs");
    const planExists = planPath ? existsSync(planPath) : false;
    const { buildPlanModePrompt } = await import("../plan/prompt.ts");
    return {
      output: buildPlanModePrompt(planPath || "", planExists),
    };
  }
}
