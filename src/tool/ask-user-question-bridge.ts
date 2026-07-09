/**
 * AskUserQuestion 桥接模块
 *
 * 解决"工具执行时没有 TUI 句柄"的问题：tool-executor 调 `tool.execute(input, signal)`，
 * 不向工具传任何 TUI 通道。AskUserQuestionTool 需要在执行中途唤起交互式选择题 UI 并阻塞
 * 等待用户作答——和权限确认/Shell 确认/Plan 审批同构（app.ts 用 setTUIConfirmCallback
 * 等回调把"请求"投影成 TUI 状态）。
 *
 * 本模块是一个模块级单例 handler 注册表（对标 agent/message-queue.ts 的桥接思路）：
 * - TUI 模式：app.ts 在 doInit 里调 setAskUserQuestionHandler 注入真正弹窗的实现。
 * - headless/SDK/CI 模式：无人注入 handler → askUserQuestion 返回 { status: "unavailable" }，
 *   工具据此告知模型"当前无法向用户提问，请用最合理的默认继续"，绝不阻塞无头进程。
 *
 * 对标 claude-code src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx
 * + components/permissions/AskUserQuestionPermissionRequest。
 */

/** 单个选项 */
export interface AskQuestionOption {
  /** 显示给用户的选项文本（1-5 词） */
  label: string;
  /** 选项说明 / 权衡解释（可选） */
  description?: string;
  /**
   * 选项预览内容（可选，仅单选题生效）。markdown / ASCII mockup / 代码片段等，
   * 选中该项时在对话框右侧并排渲染，供用户可视化对比几种方案。对标 cc 的 option.preview。
   */
  preview?: string;
}

/** 单个问题 */
export interface AskQuestion {
  /** 完整问题文本，以问号结尾 */
  question: string;
  /** chip/tag 显示的短标签 */
  header: string;
  /** 2-4 个候选项（UI 会自动追加"其他"以支持自定义输入） */
  options: AskQuestionOption[];
  /** 是否允许多选（默认 false） */
  multiSelect?: boolean;
}

/** 一次提问请求（1-4 个问题） */
export interface AskUserQuestionRequest {
  questions: AskQuestion[];
}

/**
 * 提问结果。
 * - answered：用户作答，answers 按"问题文本 → 答案"映射（多选答案以 ", " 连接）；
 *   notes（可选）按"问题文本 → 备注"映射，仅当用户给某题补了自由备注时存在。
 * - cancelled：用户主动放弃回答（ESC）。
 * - unavailable：当前无交互通道（headless/SDK/CI），无法提问。
 */
export type AskUserQuestionResult =
  | { status: "answered"; answers: Record<string, string>; notes?: Record<string, string> }
  | { status: "cancelled" }
  | { status: "unavailable" };

/** TUI 注入的提问处理器 */
export type AskUserQuestionHandler = (
  request: AskUserQuestionRequest,
  signal?: AbortSignal,
) => Promise<AskUserQuestionResult>;

let handler: AskUserQuestionHandler | null = null;

/**
 * 注册提问处理器（TUI 模式由 app.ts 注入）。
 * 返回反注册函数，便于会话结束 / 测试清理。
 */
export function setAskUserQuestionHandler(h: AskUserQuestionHandler | null): () => void {
  handler = h;
  return () => {
    if (handler === h) handler = null;
  };
}

/** 当前是否存在可用的提问通道（交互模式判定）。 */
export function hasAskUserQuestionHandler(): boolean {
  return handler !== null;
}

/**
 * 发起一次提问。工具层调用入口。
 *
 * 无 handler（headless）时立即返回 unavailable，不阻塞；handler 抛错时同样降级为
 * unavailable，保证工具永远拿得到结果、不会把异常冒泡成孤儿 tool_use。
 */
export async function askUserQuestion(
  request: AskUserQuestionRequest,
  signal?: AbortSignal,
): Promise<AskUserQuestionResult> {
  if (!handler) return { status: "unavailable" };
  try {
    return await handler(request, signal);
  } catch {
    return { status: "unavailable" };
  }
}
