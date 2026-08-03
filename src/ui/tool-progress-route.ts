/**
 * 工具进度事件的路由判定（纯函数层）。
 *
 * ## 为什么单独提一个文件
 *
 * 这段判定原先是 app.ts `buildToolExecutorDeps.onToolProgress` 里的三行 inline 分支，
 * 而**它本身就是问题三的根因**：一道 `isShell` 白名单门槛（`toolName === "bash" ||
 * "shell" || "execute_command"`）决定谁能进工具卡片，子代理不在名单里 → 进度被降级成
 * 状态栏 2s 一闪的临时提示 → 用户眼中就是"跑了 1m35s，屏幕上一个字都没有"。
 *
 * 埋在 App 私有方法的闭包里，外部拿不到引用，测试只能照抄一遍逻辑——那种测试在生产
 * 代码漂移时照样绿（教训与 history-adapter 的 buildSettledToolCallIfReady 完全同源：
 * 注入层此前零覆盖，改坏了全量单测照样通过）。提出来之后这条判定可被直接驱动。
 *
 * ## 判定改成按事件类型，而不是按工具名
 *
 * 白名单的病根不是"漏了 sub_agent 这个名字"——补上名字，下一个长跑工具还是得回来改。
 * 病根是**按工具名分派**：判定方与产出方分离，新增产出方必须记得回来登记，忘了就静默
 * 降级（没有报错，只是"看不见"）。现在按事件 `type` 分派：工具自己声明产出什么类型的
 * 进度，路由只认类型。加新工具不需要动这个函数。
 */

/** 进度事件的去向。 */
export type ToolProgressRoute =
  /** 子代理进度 → 它自己的 `sub_agent` 工具卡片下方（三档降级呈现） */
  | "agentCard"
  /** shell 类工具的 stdout/stderr 尾部快照 → 工具卡片的实时输出区 */
  | "shellCard"
  /** 其余（MCP 单行进度等）→ 状态栏 2s 临时提示 */
  | "statusBar";

/** 路由判定的入参（只取判定真正需要的字段，不依赖 App 实例） */
export interface ToolProgressRouteInput {
  toolName: string;
  /** 事件类型（`agent_progress` / `output` / MCP 各类） */
  eventType: string;
  /** 事件是否携带 string 类型的 text 字段（shell 尾部快照的载体） */
  hasText: boolean;
  /** 对应 sink 是否已就绪（无头模式下两个 sink 均为 null，必须降级到状态栏） */
  agentSinkReady: boolean;
  shellSinkReady: boolean;
}

/** shell 类工具名（进度是多行 stdout 尾部快照，走实时输出区而非活动列表）。 */
const SHELL_TOOLS = new Set(["bash", "shell", "execute_command"]);

/**
 * 判定一条工具进度事件该往哪去。
 *
 * 顺序有意义：`agent_progress` 先判，且**不看工具名**——子代理进度只可能由 sub_agent
 * 产出，再按名字二次确认属于重复判据（两处都得对才生效，其中一处漂移就静默失效）。
 *
 * sink 未就绪时一律回落 `statusBar`：无头模式没有卡片可挂，行为与改造前一致。
 */
export function routeToolProgress(input: ToolProgressRouteInput): ToolProgressRoute {
  if (input.eventType === "agent_progress") {
    return input.agentSinkReady ? "agentCard" : "statusBar";
  }
  if (SHELL_TOOLS.has(input.toolName) && input.hasText && input.shellSinkReady) {
    return "shellCard";
  }
  return "statusBar";
}
