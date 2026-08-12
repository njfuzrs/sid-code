/**
 * Todo 回注与完成度校验（P0-2 / P0-3）
 *
 * 对应《长任务遗漏-Harness根因与完成率提升方案》根因 1、2：
 * - 根因 1：todo 写完即沉没，只喂 TUI，从不回注 LLM → 模型靠工作记忆追踪清单，弱模型必然遗漏。
 * - 根因 2：任务被切成碎片、做了一半就 end_turn。
 *
 * 解决思路（对标 claude-code attachments.ts + stopHooks.ts）：
 * - P0-2：每隔 N 轮把**完整 todo 列表**作为 system-reminder 回注，让模型全程可见。
 * - P0-3：end_turn 前硬校验，仍有未完成项则注入提醒并软续命（最多 N 次），把"人肉完成度校验器"内置进 harness。
 */

import type { TodoItem } from "../tool/todo-write.ts";

/**
 * P0-2：todo 回注节流配置。
 * 弱模型（DeepSeek）记忆更短，阈值比 claude-code 的 10 略低，定为 8。
 */
export const TODO_REMINDER_CONFIG = {
  /** 距上次 todo_write ≥ N 轮才回注（避免刚写完就重复提醒） */
  TURNS_SINCE_WRITE: 8,
  /** 两次回注之间至少间隔 N 轮（避免每轮刷屏，浪费 token） */
  TURNS_BETWEEN_REMINDERS: 8,
} as const;

/** P0-3：end_turn 完成度硬校验的最大软续命次数 */
export const MAX_TODO_GATE_RETRIES = 3;

/**
 * P0-3 误判自愈阈值：续命耗尽时，若"有实质产出却不翻状态位"的次数 ≥ 此值，
 * 判定极可能是"任务已交付、只是忘标记"（而非真没做完），收尾不抛假警报。
 * 取 MAX_TODO_GATE_RETRIES：即**每一次**续命模型都在实质应答却始终不更新清单，
 * 才认定为"忘标记"——足够保守，不会把"真没做完但产出了点东西"误当忘标记放过。
 */
export const TODO_GATE_FORGOT_MARK_THRESHOLD = MAX_TODO_GATE_RETRIES;

/**
 * 判定本轮是否"有实质产出"——用于 todo gate 区分"真没做完"vs"忘标记"。
 * 产出实质内容（如输出了完整报告）却试图收尾，比"空手 end_turn"更像"活干完了忘翻状态位"。
 * 阈值与 output-stall 的语义对齐：远高于一句寒暄，约等于"至少写了一段实质文字"。
 */
export const TODO_GATE_PRODUCTIVE_TEXT_MIN = 200;

/**
 * P0-3 误判自愈：续命耗尽且判定为"极可能忘标记"时的中性收尾文案。
 * 不抛"仍有 N 项未完成"的红字警报（那会是假警报），只做一句不打扰的说明。
 * 注意：措辞不断言"已完成"（门禁读不到模型的心），只如实说"已放行收尾"。
 */
export function buildTodoGateForgotMarkMessage(): string {
  return `已完成本轮工作并收尾。如清单仍有未勾选项，多为状态标记遗漏，可让我核对。`;
}

/**
 * 方案②（deepseek-reasoning-leak 修复）：「未答复的 end_turn」最大软续命次数。
 * stream-processor 判定本轮思考漂移进正文 / 只思考不答复（无 todo 也生效）时，
 * 回注收敛提示并续命。上限比 todo gate 略小——连续 N 次仍未答复说明模型确实卡死，
 * 放行如实呈现，避免无限循环烧 token（例③ 就是重试链失效导致用户反复无反应）。
 */
export const MAX_UNANSWERED_RETRIES = 2;

/**
 * 方案②：构造「未答复的 end_turn」软续命提示（不依赖 todo）。
 * 逼模型换一种方式推进：先建 todo 拆解，再逐步执行，且**不要把思考过程当正文输出**。
 * 这是例③"请你修复→吐一堆思考→空手 end_turn→再请你修复"死循环的破局点。
 */
export function buildUnansweredEndTurnMessage(): string {
  return `<system-reminder>
上一轮没有产出面向用户的有效答复，也没有调用任何工具（疑似把内部思考过程当成了正文输出，或只思考未答复）。这不是完成任务的有效方式。
请立即改变策略：
1. 不要把分析、推演、独白当作答复直接输出——思考应当收敛为具体行动。
2. 先用 todo_write 把任务拆成可执行的小步骤，再逐步执行（调用工具去读代码 / 改文件 / 跑命令）。
3. 如果卡在某个判断上无法收敛，直接说明卡点并给出下一步最小可行动作，而不是反复推演。
请勿向用户提及本提醒。
</system-reminder>`;
}

/** 状态文案（与 claude-code messages.ts 的 `[status] content` 渲染对齐） */
function statusLabel(s: string): string {
  return s === "completed" ? "completed" : s === "in_progress" ? "in_progress" : "pending";
}

/** 未完成（pending + in_progress）项 */
export function unfinishedTodos(todos: TodoItem[]): TodoItem[] {
  return todos.filter((t) => t.status === "pending" || t.status === "in_progress");
}

/** 未完成项数量 */
export function countUnfinished(todos: TodoItem[]): number {
  return unfinishedTodos(todos).length;
}

/** 把 todo 渲染成带序号 + 状态标签的多行文本 */
function renderTodoLines(todos: TodoItem[]): string {
  return todos.map((t, i) => `${i + 1}. [${statusLabel(t.status)}] ${t.content}`).join("\n");
}

/**
 * P0-2：构造 todo 回注 system-reminder。
 * 对标 claude-code attachments.ts:3266 —— 把完整 todo 列表（含状态）作为
 * system-reminder 注入，补偿弱模型不可靠的工作记忆，让"还剩哪些没做"全程可见。
 */
export function buildTodoReminder(todos: TodoItem[]): string {
  const unfinished = countUnfinished(todos);
  return `<system-reminder>
这是你当前的任务清单（请勿向用户提及本提醒）：
${renderTodoLines(todos)}
仍有 ${unfinished} 项未完成。请继续推进，不要遗漏；完成每一项后立即用 todo_write 更新状态。
注意：如果某项其实**已经做完**（代码已改、验证已过），只是忘了标记，请直接用 todo_write 把它标为 completed，然后如实收尾——不要为了凑"未完成"去臆造用户没要求的新工作，也不要假设已交付的产物存在故障再去排查。
</system-reminder>`;
}

/**
 * P0-3：构造 end_turn 完成度拦截消息（软续命）。
 * 模型试图收尾但仍有未完成项时注入，驱动它继续做完而非提前 end_turn。
 *
 * `alreadyDelivered`（本轮已输出实质正文，由调用方按 TODO_GATE_PRODUCTIVE_TEXT_MIN 判定）
 * 时追加"禁止重述"约束：这是「重复输出」缺陷的根治点。
 *
 * 缺陷复现（2026-07-30，docs/_template/遗留最后一项todoitem…txt 附录 TUI 转录）：
 * 模型输出完整报告后 end_turn，只是漏标最后一项 → 本 gate 拦下 → 模型正确判断出
 * "报告已在上一轮完整输出，只是忘了标记"→ 补标记 → todo_write 全部完成分支回
 * "请汇总执行结果并告知用户"（无条件祈使句）→ 模型把整份报告**又打了一遍**。
 * 模型自己的判断是对的，是被 harness 的指令盖过去了。所以修复要落在"harness 别在
 * 已交付时下汇总命令"，而不是指望模型顶住指令。
 */
export function buildTodoGateMessage(todos: TodoItem[], alreadyDelivered = false): string {
  const pending = unfinishedTodos(todos);
  const noRestate = alreadyDelivered
    ? `\n注意：你本轮**已经输出过实质结论**。补标记后请仅用一句话收尾，**不要重述/重新输出**已经给过用户的报告、结论或代码——重复输出对用户是纯噪音。`
    : "";
  return `<system-reminder>
检测到你试图结束本轮对话，但任务清单中仍有 ${pending.length} 项未完成：
${renderTodoLines(pending)}
请对照实际进展判断，二选一：
1. 若这些项**尚未真正做完**：继续完成，不要提前收尾；完成每一项后用 todo_write 标记 completed。
2. 若这些项**其实已经做完**（代码已改、构建/测试已过），只是忘了标记：直接用 todo_write 标为 completed 并如实收尾。**切勿**为了让清单"看起来还有活"而去臆造用户没要求的新工作，或假设已交付的产物有故障再去排查——现状描述不等于 bug 报告，没有用户新反馈就不要脑补故障。
如果某项确实无法完成，请明确说明原因（而不是默默跳过或谎报完成）。${noRestate}
</system-reminder>`;
}

/**
 * P0-3：续命次数耗尽时的"放行但如实列出未完成项"消息。
 * 不假装完成——把未尽事项明确呈现给用户。
 */
export function buildTodoGateExhaustedMessage(todos: TodoItem[]): string {
  const pending = unfinishedTodos(todos);
  return `⚠️ 仍有 ${pending.length} 项任务未完成（已达自动续推上限 ${MAX_TODO_GATE_RETRIES} 次）：\n${renderTodoLines(pending)}`;
}
