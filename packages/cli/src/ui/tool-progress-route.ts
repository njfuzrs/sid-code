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

/**
 * 进度事件的去向。
 *
 * 注意 `toolCard` 只回答**去哪**（挂到工具卡片上），不决定**长什么样**。呈现形态由渲染层
 * 按工具自行分流（ToolMessage.tsx）：shell 类的多行 stdout 快照走命令行下方的独立多行块，
 * 其它工具的单行阶段文案走 header 下方的 progressMessage。两者共用这一条侧信道。
 */
export type ToolProgressRoute =
  /** 子代理进度 → 它自己的 `sub_agent` 工具卡片下方（三档降级呈现） */
  | "agentCard"
  /** 带文本的进度 → 对应工具的卡片（呈现形态由渲染层按工具分流，见上） */
  | "toolCard"
  /** 其余（无文本的纯类型信号）→ 状态栏 2s 临时提示 */
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
  /** 工具卡片进度 sink（历史名 shellSink，实际服务所有带文本的工具进度） */
  toolCardSinkReady: boolean;
}

/**
 * shell 类工具名（进度是多行 stdout 尾部快照，走实时输出区而非活动列表）。
 *
 * 保留这个名单**不是**为了决定"谁能进卡片"（那个门槛已经拆掉，见 routeToolProgress），
 * 而只是记录"谁的 output 是多行 stdout 快照"——将来若两类进度需要不同的呈现密度
 * （shell 要等宽多行、阶段文案要单行），判据仍在这里。
 */
const SHELL_TOOLS = new Set(["bash", "shell", "execute_command"]);

/** 该工具名的 output 进度是否为 shell 式多行 stdout 快照。 */
export function isShellStyleProgress(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName);
}

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
  // 任何**带文本的进度**都进它自己的工具卡片，不再要求工具名在 shell 名单里。
  //
  // 这是本文件开头那段自述的最后一步。它当时把 `agent_progress` 从名单制改成了类型制，
  // 却把另一半留在原地：`output` 类型仍要过 `SHELL_TOOLS.has(toolName)` 这道名字门槛。
  // 于是新工具接了 onProgress、事件也发出来了，却被静默降级成状态栏 2s 一闪——LSP 就是
  // 下一个撞上来的（阶段文案发得出去、落不到卡片上，用户仍然只看到光秃秃的 `⏺ lsp`）。
  //
  // 判据现在是纯粹的**能力问题**：有文本可显示 + 有卡片可挂 → 挂卡片。工具名不参与。
  // 语义上也说得通：`{type:"output", text}` 本身就宣告了"这是给人看的一行/一段文本"。
  //
  // 为什么放开不会串味（这是当初那道名字门槛真正想防的事）：呈现形态在渲染层是**按工具
  // 二次分流**的，不由这里决定——ToolMessage.tsx 的多行 stdout 块以 `hasShellCommand`
  // 为闸门，非 shell 工具的文本只会走 header 下方的单行 progressMessage。所以放开去向
  // 不会让 web_fetch 的进度挤进 shell 的多行输出区。
  if (input.hasText && input.toolCardSinkReady) {
    return "toolCard";
  }
  return "statusBar";
}
