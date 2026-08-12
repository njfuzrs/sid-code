/**
 * TodoWrite 工具
 * 执行阶段轻量级进度追踪，对标 Claude Code TodoWriteTool
 * 解决 Plan Mode 套娃问题：执行阶段缺少进度管理 → agent 被迫重新 enter_plan_mode
 *
 * fix_type: new_module（§0.3 L≥3 流程）
 * 参考: docs/bugfixes/todo/PlanMode-套娃根因与TodoWrite方案.md
 * 对标: Claude Code src/tools/TodoWriteTool/TodoWriteTool.ts
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const todoWriteSchema = lazySchema(() =>
  z.object({
    todos: z
      .array(
        z.object({
          content: z.string().describe("任务描述（祈使形式），如 '新增 crash-marker.ts'"),
          active_form: z.string().describe("进行时形式，如 '正在新增 crash-marker.ts'"),
          status: z.enum(["pending", "in_progress", "completed"]).describe("任务状态"),
        }),
      )
      .describe("完整的 todo 列表（全量替换）"),
  }),
);

export interface TodoItem {
  /** 任务描述（祈使形式），如 "新增 crash-marker.ts" */
  content: string;
  /** 进行时形式，如 "正在新增 crash-marker.ts" */
  activeForm: string;
  /** 任务状态 */
  status: "pending" | "in_progress" | "completed";
}

function formatTodoItem(t: TodoItem, idx: number): string {
  const icon = t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⬜";
  return `  ${icon} ${idx + 1}. ${t.content}`;
}

function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return "  (空)";
  return todos.map((t, i) => formatTodoItem(t, i)).join("\n");
}

/**
 * 按 `content` 建索引比对新旧状态（**不能按数组下标**）。
 *
 * 根因（2026-08-01 实测复现）：`todos` 是**全量替换**语义，模型可以插入 / 删除 / 重排项。
 * 旧实现拿 `oldTodos[i]` 与 `newTodos[i]` 逐位比，下标一错位就双向错报：
 *   - **假报完成**：`[A(done), B, C]` 最前面插入新项 → 报「✅ 已完成: A」，可本轮无一项新完成；
 *   - **漏报完成**：`[X, Y]` 删掉 `X` 且 `Y` 真完成 → 一句「已完成」都不报。
 * 这是模型从 `tool_result` 能拿到的**唯一进度反馈信号**，假报让它以为已勾（于是不再去勾），
 * 漏报让它拿不到「你刚完成了一项」的正反馈——两者都直接加重「非实时更新」缺陷。
 *
 * 用「按 content 分桶的状态队列」而非 `Map<content, status>`：content 允许重复（模型偶尔
 * 会提交同名项），单值 Map 会让后者覆盖前者、又退化成一种错位。消费时 `shift()` 逐个配对。
 */
function buildOldStatusIndex(oldTodos: TodoItem[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const t of oldTodos) {
    const bucket = index.get(t.content);
    if (bucket) bucket.push(t.status);
    else index.set(t.content, [t.status]);
  }
  return index;
}

/**
 * 本轮**新**变为 completed 的项（按 content 配对，非下标）。
 * 在旧清单里找不到同名项的一律不报——那是模型新插入的条目，它的完成不是"本轮翻的状态位"，
 * 报出来就是假报（宁可少报，不可假报：假报会让模型误判某项已勾而不再去勾）。
 */
function newlyCompleted(oldTodos: TodoItem[], newTodos: TodoItem[]): TodoItem[] {
  const index = buildOldStatusIndex(oldTodos);
  const done: TodoItem[] = [];
  for (const n of newTodos) {
    const bucket = index.get(n.content);
    if (!bucket || bucket.length === 0) continue; // 旧清单里没有 → 新插入项，不报
    const oldStatus = bucket.shift()!;
    if (oldStatus !== "completed" && n.status === "completed") done.push(n);
  }
  return done;
}

/**
 * L1 前向推进指令（对标 claude-code `TodoWriteTool.ts:105`，并做得更细）。
 *
 * 为什么这是实时化的**主力通道**：它必达（不受任何节流 / 去重 / 封顶管辖，每次调用 100%
 * 送达）、零边际 token 成本（复用本就要回传的 `tool_result`）、零幻觉风险（它是工具返回值，
 * 弱模型不可能误判成"用户又发了半句话"）。我们原先把实时化全押在"每 8 轮回注一次 reminder"
 * 那条最脆弱的通道上（实测 60 轮只注入 1 次），却空着这条最稳的。
 *
 * 比对标做得更细的地方：对标是一句**不看清单内容的无状态套话**（"Ensure that you continue
 * to use the todo list…"），我们按清单实际状态分流、把"下一个动作"点名到具体项。依据是
 * 弱模型（本缺陷现场是 `glm-5.2`）记忆更短、对具体指令的执行率显著高于泛化提醒——同一理由
 * 下 `TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE` 也定得比对标的 10 更低（8）。
 *
 * ⚠️ 红线：**只加前向压力，绝不加拦截**。见 execute() 里 statusAdvisories 上方那段注释记录的
 * 硬拦截代价（模型白等 105.4 秒重交一份逐字相同的清单，纯自伤）。
 */
function buildForwardDirective(todos: TodoItem[]): string | null {
  if (todos.length === 0) return null;

  const current = todos.find((t) => t.status === "in_progress");
  if (current) {
    return (
      `下一步：当前进行中的是「${current.content}」。做完它后**立即**用 todo_write 把它标为 completed，` +
      `并把下一项置为 in_progress——不要攒到最后一起标记。`
    );
  }

  const nextPending = todos.find((t) => t.status === "pending");
  if (nextPending) {
    // "没有 in_progress" 这条状态判断由 statusAdvisories 点名承载（见 execute()），
    // 此处不重复那句话，只强调实时流转纪律，避免同一轮返回里出现两段近义文本。
    return `请继续用 todo_write **实时**流转状态：每完成一项立即标记 completed，不要攒到最后一起标记。`;
  }

  return `请继续用 todo_write 追踪进度；若清单已全部推进完毕，如实收尾即可。`;
}

function formatTodoDiff(oldTodos: TodoItem[], newTodos: TodoItem[]): string {
  const lines: string[] = [];
  lines.push("任务清单已更新:\n");
  lines.push("更新后:");
  lines.push(formatTodoList(newTodos));

  // 检测状态变更（按 content 配对，非下标——见 newlyCompleted 注释）
  for (const t of newlyCompleted(oldTodos, newTodos)) {
    lines.push(`\n✅ 已完成: ${t.content}`);
  }

  // 统计
  const completed = newTodos.filter((t) => t.status === "completed").length;
  const inProgress = newTodos.filter((t) => t.status === "in_progress").length;
  const pending = newTodos.filter((t) => t.status === "pending").length;
  lines.push(
    `\n进度: ${completed}/${newTodos.length} 已完成` +
      (inProgress > 0 ? `, ${inProgress} 进行中` : "") +
      (pending > 0 ? `, ${pending} 待开始` : ""),
  );

  // L1：前向推进指令（每次调用必达）
  const directive = buildForwardDirective(newTodos);
  if (directive) lines.push(`\n${directive}`);

  return lines.join("\n");
}

const VALID_STATUSES = new Set(["pending", "in_progress", "completed"]);

/**
 * 从持久化快照里挑出合法 todo 项（脏项跳过，不抛错）。
 *
 * 抽成共用函数是因为 `hydrate()` 现在要清洗**两份**数组（展示清单 `todos` + 事实清单
 * `lastWritten`）。两份各写一遍循环，早晚会漂移出"一份校验严一份松"的不一致。
 *
 * 容错原则：绝不因脏快照阻断恢复——恢复失败的代价（用户丢清单）远大于少恢复几项。
 */
function sanitizeTodoSnapshot(raw: unknown[]): TodoItem[] {
  const out: TodoItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const t = item as Partial<TodoItem>;
    if (typeof t.content !== "string" || !t.content.trim()) continue;
    if (typeof t.activeForm !== "string" || !t.activeForm.trim()) continue;
    if (typeof t.status !== "string" || !VALID_STATUSES.has(t.status)) continue;
    out.push({ content: t.content, activeForm: t.activeForm, status: t.status });
  }
  return out;
}

export class TodoWriteTool implements Tool {
  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = todoWriteSchema();

  /** P2-3：状态管理类工具，清单内容随进展自然变化、连续更新是正当行为，豁免循环检测 */
  readonly exemptFromLoopDetection = true;

  /**
   * 整条卡片不渲染（对标 cc `TodoWriteTool.ts:48` 的 `userFacingName() { return '' }`
   * + `renderToolUseMessage() { return null }` + 不实现 `renderToolResultMessage`）。
   *
   * 满足 hidden 的两条判据（见 `types.ts` 的 `resultDisplayMode`）：
   *   1. 本工具 `output` 是**专门写给模型的**——清单 diff 之后紧跟前向推进指令
   *      （`buildForwardDirective`）与状态建议（`statusAdvisories`）。用户读到
   *      「请继续用 todo_write **实时**流转状态」只会困惑：那是对模型说的。
   *   2. 清单的权威呈现是 **TodoPanel**（输入框上方常驻面板，`app.ts:6365` 每次执行后同步）。
   *      `⎿` 里那份是第二遍，且是拼成给模型读的形态。cc 的注释正是拿本工具举例：
   *      「TodoWrite updates the todo panel, not the transcript」。
   *
   * ⚠️ 全部完成时 `currentTodos` 被清空、TodoPanel 随之收起（见 execute 的 allDone 分支），
   * 那一刻屏幕上确实没有「任务全做完了」的痕迹。这是**刻意接受**的：完成结论由模型的
   * 正文收尾承担（工具返回值里那句分流提示就是为此而写），而不是靠一张残留的全绿清单。
   * 不要为此把本字段降级为 "summary" —— 那会让每次 todo_write 都留一行噪音卡片。
   */
  readonly resultDisplayMode = "hidden" as const;

  /**
   * 短描述层（对标 claude-code 的**双层工具描述**：`PROMPT` 9114 字符送 API，
   * `DESCRIPTION` 269 字符供工具列表 / 搜索场景）。
   *
   * 关键不在于"多一个搜索字段"，而在于**那句最重要的纪律必须在每一层都出现**：对标那份
   * 269 字符的短描述里专门留了一句 `Make sure that at least one task is in_progress at all
   * times.`——它把"必须有一项 in_progress"做成了**在任何呈现层级都不会被裁掉**的核心纪律。
   * 我们原先只有单层 `description()`（3000+ 字符），那句话埋在 `## 任务状态` 小节里，
   * 上下文压力大或走 ToolSearch 摘要路径时容易被稀释。
   */
  readonly searchHint =
    "todo task list progress tracking 任务 清单 进度 追踪 实时 更新 状态 流转 " +
    "始终保持至少一项 in_progress；每完成一项立即标记 completed，不要攒到最后一起标记";

  private currentTodos: TodoItem[] = [];
  /**
   * 最近一次成功写入的**原始**清单（全量，不受"全部完成即清空"影响）。
   *
   * 为什么需要它（发现 4a → 修复 5 的前置）：`execute()` 在全部完成时把 `currentTodos`
   * 置空（那是 TUI 面板"任务做完就收起来"的设计），于是三处连锁：
   *   `getTodos()` 返 `[]` → `app.ts` 的 `getTodoState()` 返 `null` → queryLoop 拿不到终态。
   * 后果是 `~/.sid-code/progress/<id>.md` **永久停在最后一次未完成态**——本次排查就吃了这个亏：
   * 残留文件写着 `0 已完成 / 18 待办`，它无法自证是"真没推进"还是"推进了但终态没落盘"。
   *
   * 故独立留一份快照：清空是**展示语义**，而进度落盘要的是**事实语义**，两者不该共用一个字段。
   */
  private lastWrittenTodos: TodoItem[] = [];
  /**
   * todo_write 被成功调用的次数（单调递增）。
   * P0-2 用它判断"距上次 todo_write 多少轮"：queryLoop 在每轮记录该值的快照，
   * 与当前值比较即可知道这段时间内模型有没有更新过清单。
   */
  private writeVersion = 0;

  name(): string {
    return "todo_write";
  }

  description(): string {
    return `使用此工具创建和管理当前编码会话的结构化任务清单。帮助你追踪进度、组织复杂任务、向用户展示完整性。

## 何时使用
1. 复杂多步骤任务 — 需要 3 个或更多独立步骤
2. 非平凡复杂任务 — 需要仔细规划或多个操作
3. 用户明确要求 todo 列表
4. 用户提供多个任务（编号或逗号分隔）
5. 收到新指令后 — 立即将用户需求捕捉为 todo 项
6. ExitPlanMode 批准后 — 将批准的 plan 拆解为 todo 项，逐条执行
7. 开始一个任务前 — 先标记为 in_progress 再开始工作
8. 完成任务后 — 立即标记为 completed（不要批量完成）

## 何时不使用

跳过 todo_write 当：
1. 只有一个简单任务
2. 任务太简单，追踪没有组织价值
3. 任务可以在 3 个以下简单步骤内完成
4. 任务是纯对话或信息查询

注意：只有一个简单任务时，直接做就行，不需要建清单。

## 正例（应使用 todo_write）

<example>
用户：我想给设置页加一个深色模式切换开关。做完后记得跑测试和构建！
助手：*创建 todo 清单，包含以下项：*
1. 在设置页创建深色模式切换组件
2. 添加深色模式状态管理（context/store）
3. 实现深色主题的 CSS-in-JS 样式
4. 更新已有组件支持主题切换
5. 运行测试和构建，处理可能的失败或错误
*开始做第一项任务*

<reasoning>
助手使用 todo 清单因为：
1. 添加深色模式是多步骤功能，涉及 UI、状态管理、样式变更
2. 用户明确要求跑测试和构建
3. 助手推断测试和构建也需要作为一个任务，添加到清单末尾
</reasoning>
</example>

<example>
用户：帮我把函数 getCwd 重命名为 getCurrentWorkingDirectory，全项目替换。
助手：*先用 grep 搜索工具定位所有 getCwd 出现的位置*
在 8 个文件中找到 15 处 getCwd 引用。
*创建 todo 清单，每个需要更新的文件一条任务*

<reasoning>
助手使用 todo 清单因为：
1. 先用工具搜索了解任务范围
2. 发现分布在多个文件中，确定这是多步骤复杂任务
3. todo 清单确保每一处都被追踪和系统性更新，不会遗漏
</reasoning>
</example>

<example>
用户：帮我实现这些电商功能：用户注册、商品目录、购物车、结算流程。
助手：*创建 todo 清单，将每个功能拆解为具体任务*
我们先从用户注册开始。这需要创建数据库模型、API 端点，以及与现有认证系统集成的前端表单。

<reasoning>
助手使用 todo 清单因为：
1. 用户提供了多个复杂功能（逗号分隔的列表）
2. todo 清单帮助把大功能拆成可管理的小任务
3. 可以追踪整个实现过程的进度
</reasoning>
</example>

<example>
用户：能帮我优化 React 应用的性能吗？渲染很慢。
助手：*先分析组件结构、渲染模式、状态管理和数据获取*
分析完代码后，发现多个性能问题。
*创建 todo 清单：1) 为 ProductList 的昂贵计算添加 memoization，2) 为 Dashboard 的长列表添加虚拟化，3) 优化 Gallery 组件的图片加载，4) 修复 ShoppingCart 的状态更新循环，5) 检查打包体积并实施代码分割*
先从 ProductList 的 memoization 开始。

<reasoning>
助手使用 todo 清单因为：
1. 先分析代码库，识别具体性能问题
2. 基于分析结果，识别出多个优化点
3. 性能优化是非平凡任务，需要多步骤
4. todo 清单帮助有条理地跟踪各组件的改进
</reasoning>
</example>

## 反例（不应使用 todo_write）

<example>
用户：Python 怎么打印 Hello World？
助手：Python 中打印 "Hello World" 很简单：
print("Hello World")
运行后会输出 "Hello World"。

<reasoning>
助手没有用 todo 清单，因为这是单一简单任务，一步就能完成。不需要追踪多个步骤。
</reasoning>
</example>

<example>
用户：git status 命令是干什么的？
助手：git status 命令显示工作目录和暂存区的当前状态，包括哪些改动已暂存、哪些未暂存、哪些文件未被 Git 跟踪。

<reasoning>
助手没有用 todo 清单，因为这是纯信息查询，没有实际的编码任务需要完成。
</reasoning>
</example>

<example>
用户：给 calculateTotal 函数加个注释说明它做什么。
助手：好的，让我给 calculateTotal 函数加个注释。
*用 edit 工具在 calculateTotal 函数上方添加注释*

<reasoning>
助手没有用 todo 清单，因为这是单一简单任务，局限在一个位置。加注释不需要追踪多个步骤。
</reasoning>
</example>

<example>
用户：帮我跑 npm install，告诉我结果。
助手：我来执行 npm install。
*执行 npm install*
命令执行成功。所有依赖已安装。

<reasoning>
助手没有用 todo 清单，因为这是单条命令执行，立即出结果。没有多个步骤需要追踪，不需要清单。
</reasoning>
</example>

## 任务状态
- pending: 尚未开始
- in_progress: 正在进行（**理想情况下同时只保留一个**）
- completed: 已完成

## 任务管理规则
- **任何时刻都应保持至少一项 in_progress**（清单未全部完成时）—— 没有"当前项"就没有实时进度，
  也就没有"做完当前项要翻状态位"的触发时机。首次建完清单就要立刻把第 1 项置为 in_progress。
- 实时更新状态
- 完成后立即标记（不要攒到最后一起标记）
- **同一时刻理想情况下只有一个 in_progress** —— 这是让进度展示清晰的建议，不是硬性校验：
  多个 in_progress 不会被拒绝，清单照常保存，只会在返回里附一句提示。
  但请把它当默认习惯：一次专注一件事，做完再流转下一件。
- 完成当前任务再开始新任务
- 删除不再相关的任务

## 全集覆盖规则（重要）
- 当任务来自一份文档/计划/编号需求列表时，**首次 todo_write 必须逐条枚举其中的全部条目**，不要只挑其中几件做。
- 清单一旦建立，总数应保持稳定——后续只更新各项的 status，不要悄悄缩减清单规模。
- 遗漏文档中的任何一个条目都视为任务未完成。宁可多列、标注后续，也不要漏列。

## 任务完成要求
- 只有完全完成才能标记 completed
- 遇到错误、阻塞或无法完成 → 保持 in_progress
- 被阻塞时 → 创建新任务描述需要解决的问题
- 绝对不能在没有完全完成时标记 completed：测试失败、实现不完整、遇到未解决错误、找不到需要的文件或依赖

如有疑问，使用此工具。主动管理任务展示你的细致度，确保完成所有需求。`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(todoWriteSchema()) as Record<string, unknown>;
  }

  readOnly(): boolean {
    return false;
  }

  isConcurrencySafe(): boolean {
    return true;
  }

  /** 获取当前 todo 列表的深拷贝（供 TUI 面板读取，防止外部修改污染内部状态） */
  getTodos(): TodoItem[] {
    return this.currentTodos.map((t) => ({ ...t }));
  }

  /**
   * 获取最近一次成功写入的**原始**清单（深拷贝），**不受"全部完成即清空"影响**。
   *
   * 与 `getTodos()` 的分工是**展示语义 vs 事实语义**（见 `lastWrittenTodos` 字段注释）：
   * - `getTodos()`：TUI 面板用。全部完成时返 `[]`，面板收起来，这是刻意的。
   * - 本方法：进度落盘 / 可观测性用。要的是"清单最后长什么样"，含全部完成的终态。
   *
   * ⚠️ 不要图省事把 `getTodos()` 改成返回这一份——那会让 TUI 在任务全完成后仍挂着
   * 一张全绿清单不消失，是行为回退。两个语义分两个入口是**结论**，不是重复代码。
   */
  getLastWrittenTodos(): TodoItem[] {
    return this.lastWrittenTodos.map((t) => ({ ...t }));
  }

  /**
   * 重置内部清单状态（/clear 时调用）。
   * 仅清 UI 层 todos 不够：本工具内部的 currentTodos 是模块级私有状态，
   * /clear 后若不重置，下次只看 TodoPanel 不提交新 todo 会看到旧清单"幽灵"。
   * writeVersion 单调递增、不归零——它是 queryLoop 回注判定的全局时序基准，
   * 归零会让清空后的首次 todo_write 被误判为"清单没更新过"。
   */
  reset(): void {
    this.currentTodos = [];
    // 事实快照同样要清：否则 /clear 后新会话的进度落盘会取到上一个任务的终态清单。
    this.lastWrittenTodos = [];
  }

  /**
   * 获取 todo_write 成功调用次数（单调递增）。
   * P0-2：queryLoop 据此判断"距上次更新清单多少轮"，决定是否回注 todo system-reminder。
   */
  getWriteVersion(): number {
    return this.writeVersion;
  }

  /**
   * 序列化当前 todo 清单为可持久化快照（写入会话 JSONL 的 todo_state metadata，resume 回灌）。
   *
   * 根因：currentTodos 是纯内存态，此前从未持久化也从未回灌——`-c` 恢复后 TodoWriteTool 是
   * 全新空实例，TodoPanel 因 todos 为空整块隐藏，用户感知为"任务清单恢复后消失"。work-log
   * 只把进度以文本 reminder 每 N 轮回注给模型，不足以复原用户可见的 TodoPanel。
   *
   * 只存清单本体（content/activeForm/status）。writeVersion 是 queryLoop 回注判定的全局时序
   * 基准、单调递增，不跨会话保留——恢复后从 0 起不影响回注逻辑（首次比较即视为"有更新"）。
   *
   * ─── 2026-08-02：补 `lastWritten`，堵住"全部完成后 resume 丢终态"（方案 §9-5）───
   *
   * `todos` 取 `currentTodos`，而它在全部完成时被刻意清空（面板收起）。于是**恰好在任务
   * 全做完这个最该留痕的时刻**，快照是 `{todos: []}`：resume 后 `getLastWrittenTodos()`
   * 返空 → `getTodoTerminalState()` 返 null → 终态进度快照（修复 5）在续接会话里静默失效，
   * 跨会话也看不到"上次到底做完了什么"。
   *
   * 修法是**把事实语义一并落盘**，而不是让 `todos` 改读 `lastWrittenTodos`——后者会让
   * resume 后 TUI 挂着一张全绿清单不消失，是明确的行为回退（见 `getLastWrittenTodos` 注释）。
   * 两个语义在快照里也分两个字段，与内存里的分工一一对应。
   *
   * 只在**确实会丢信息**时才写这个字段（`currentTodos` 空而 `lastWrittenTodos` 非空，即
   * allDone 分支）。其余情况两者等价，省掉它可让绝大多数快照与旧格式逐字节一致，
   * 不给持久化格式添无谓 churn。
   */
  serialize(): { todos: TodoItem[]; lastWritten?: TodoItem[] } {
    const snap: { todos: TodoItem[]; lastWritten?: TodoItem[] } = {
      todos: this.currentTodos.map((t) => ({ ...t })),
    };
    if (this.currentTodos.length === 0 && this.lastWrittenTodos.length > 0) {
      snap.lastWritten = this.lastWrittenTodos.map((t) => ({ ...t }));
    }
    return snap;
  }

  /**
   * 从持久化快照回灌 todo 清单（resume 恢复路径调用）。
   *
   * 容错：快照缺字段/类型不符/status 非法时，跳过该项而非抛错——绝不因脏快照阻断恢复。
   * 直接覆盖 currentTodos（resume 时本就是空实例，覆盖等价于"继续之前的清单"）。
   * 不触碰 writeVersion（保持从 0 起的时序基准语义）。
   *
   * ─── 2026-08-02：一并回灌事实快照 ───
   *
   * 此前只写 `currentTodos`，与 `reset()`（两个都清）不对称：resume 后 `lastWrittenTodos`
   * 恒为空，`getTodoTerminalState()` 返 null，续接会话落不了终态进度快照。
   *
   * 兼容旧快照（无 `lastWritten` 字段）：回退到 `todos`。这对非 allDone 的快照本就等价
   * （两者内容相同），对旧的 allDone 空快照则维持现状——信息在写盘时就已经丢了，
   * 读侧变不出来。
   */
  hydrate(snapshot: { todos?: unknown; lastWritten?: unknown } | undefined | null): void {
    if (!snapshot || typeof snapshot !== "object") return;
    const raw = (snapshot as { todos?: unknown }).todos;
    if (!Array.isArray(raw)) return;
    this.currentTodos = sanitizeTodoSnapshot(raw);
    // 事实语义：优先取 lastWritten（allDone 时它才是"清单最后长什么样"），
    // 缺失则回退到展示清单。两者都脏 → 保持空，与 reset() 后的状态一致。
    const rawLast = (snapshot as { lastWritten?: unknown }).lastWritten;
    this.lastWrittenTodos = Array.isArray(rawLast)
      ? sanitizeTodoSnapshot(rawLast)
      : [...this.currentTodos];
  }

  async execute(input: unknown, _signal?: AbortSignal): Promise<ToolResult> {
    const params = input as { todos?: unknown };

    // 校验 todos 是数组
    if (!Array.isArray(params?.todos)) {
      return {
        output: "todos 必须是数组。格式: { todos: [{ content, active_form, status }] }",
        isError: true,
      };
    }

    // 协议层字段名是 active_form（tool_use 输入边界）；内部 TodoItem 仍用 activeForm——
    // 后者是被 TodoPanel/todos 命令/持久化快照广泛引用的内部数据模型，不是 schema 边界本身，
    // 不级联重命名（见 lsp.ts 等文件的同一原则）。
    const rawTodos = params.todos as Array<{
      content?: unknown;
      active_form?: unknown;
      status?: unknown;
    }>;

    // 校验每个 todo 项（读取的是协议字段名 active_form）
    for (let i = 0; i < rawTodos.length; i++) {
      const t = rawTodos[i];
      if (!t || typeof t.content !== "string" || !t.content.trim()) {
        return {
          output: `第 ${i + 1} 个 todo 项缺少有效的 content 字段`,
          isError: true,
        };
      }
      if (typeof t.active_form !== "string" || !t.active_form.trim()) {
        return {
          output: `第 ${i + 1} 个 todo 项缺少有效的 active_form 字段`,
          isError: true,
        };
      }
      if (!VALID_STATUSES.has(t.status as string)) {
        return {
          output: `第 ${i + 1} 个 todo 项的 status 无效: "${t.status}"。有效值: pending, in_progress, completed`,
          isError: true,
        };
      }
    }

    // 桥接为内部 TodoItem 结构（字段名 activeForm，供下游 UI/持久化复用，见上方注释）
    const todos: TodoItem[] = rawTodos.map((t) => ({
      content: t.content as string,
      activeForm: t.active_form as string,
      status: t.status as TodoItem["status"],
    }));

    // 检查全部完成（必须在 in_progress 校验之前，否则 [{completed}, {completed}] 会被误杀）
    const allDone = todos.length > 0 && todos.every((t) => t.status === "completed");

    // ─── 2026-07-30 修复：「恰好一个 in_progress」从硬拒绝降级为软提示 ───
    //
    // 旧实现把这条**提示词层面的规范**做成了 isError 硬拦截，直接丢弃整次写入。
    // 三条证据说明这是过度执行：
    //
    // 1. 对标实现只把它当建议，不做校验。claude-code 的 TodoWriteTool.call() 里
    //    **没有任何** in_progress 计数检查，规范只写在提示词里且明确带 hedge:
    //    「**Ideally** you should only have one todo as in_progress at a time」。
    //    其 V2 的 TaskUpdateTool 同样不校验。
    // 2. 对标实现的 UI 按**复数**渲染 in_progress（TaskListV2.tsx:153
    //    `tasks.filter(t => t.status === 'in_progress').sort(byIdAsc)`），我们的
    //    TodoPanel.tsx:287 也一样——即多个 in_progress 在展示层根本不是问题。
    // 3. 我们自己的 structured-task-store（多 agent 协作）本来就允许多个 in_progress
    //    并存（每个 teammate 各占一个，见 structured-task-store.ts:353），
    //    两套任务模型对同一语义给出相反的硬约束，本身就不自洽。
    //
    // 代价是实测的：某会话提交 12 条清单、其中 4 条 in_progress 被拒，模型 105.4 秒
    // 后重试，而两次提交的 content 数组**逐字相同**、只有 status 不同——这次往返
    // 没有产生任何信息，纯属自伤。
    //
    // 现在的处理：**接受写入**，把规范作为提示附在成功输出里。模型能看到纠正建议，
    // 但已经做的工作不会被丢掉。同理适用于「有非 pending 却无 in_progress」——
    // 例如 [completed, pending, pending] 是刚做完一项、正要挑下一项的正常中间态。
    //
    // ─── 2026-08-01 修复：去掉 `hasNonPending` 前置，补上「全 pending 首建」这个入口态 ───
    //
    // 旧条件是 `hasNonPending && inProgressCount === 0`，于是**全 pending** 的清单
    // （`hasNonPending === false`）两条分支都不触发、零提示。守卫方向正好反了：
    // 「全 pending、无 in_progress」恰恰是**保证不会有实时更新的那个形态**——没有"当前项"
    // 这个锚点，就没有"做完当前项要翻状态位"的触发时机。旧守卫只在**已经开工**后才管，
    // 正好漏掉了最需要管的入口态。本缺陷现场就是这样：18 项全 pending 首建后再没碰过清单。
    const statusAdvisories: string[] = [];
    if (!allDone) {
      const inProgressCount = todos.filter((t) => t.status === "in_progress").length;
      if (inProgressCount > 1) {
        statusAdvisories.push(
          `提示：当前有 ${inProgressCount} 个 in_progress。清单已按你提交的内容保存，但建议同一时刻只保留 1 个 in_progress、其余置 pending——这样进度展示更清晰，也更容易发现自己是否在并行摊开太多任务。`,
        );
      } else if (inProgressCount === 0 && todos.length > 0) {
        // 点名下一项（而非泛泛说"把下一项置为 in_progress"）：弱模型对具体指令的执行率
        // 显著高于泛化提醒，与 buildForwardDirective 的分流同源、可共用同一锚点。
        const nextPending = todos.find((t) => t.status === "pending");
        const named = nextPending ? `（建议是「${nextPending.content}」）` : "";
        statusAdvisories.push(
          `提示：当前没有 in_progress 任务。清单已保存，但若你正要继续推进，` +
            `请先把下一项${named}置为 in_progress 再开始工作——这样进度才是实时可见的。`,
        );
      }
    }

    // 保存旧状态
    const oldTodos = [...this.currentTodos];

    // 校验通过、即将更新状态 → 记一次成功写入（P0-2 回注判定用）
    this.writeVersion++;

    // 更新为新状态（全量替换）
    this.currentTodos = allDone ? [] : todos;
    // 事实语义快照：不受 allDone 清空影响，供进度落盘取终态（见字段注释 / 发现 4a）
    this.lastWrittenTodos = todos;

    // 空列表检测（全部完成 → 清空清单）
    //
    // ⚠️ 这句文案曾是「重复输出」缺陷的直接触发点（2026-07-30 实测，转录见
    // docs/_template/遗留最后一项todoitem…txt）。旧文案是**无条件祈使句**
    // 「请汇总执行结果并告知用户」——模型收到就照做。而本工具最常见的调用时机之一
    // 恰恰是「正文已经输出完、只是回头补标最后一项」，此时"汇总"是错的：实测模型
    // 已经自己判断出"报告上一轮发过了，只是忘标记"，却仍被这句指令驱动着把整份
    // 报告重打了一遍，用户侧看到两份一模一样的长报告。
    //
    // 本工具是纯状态容器，拿不到"本轮是否已输出正文"（那是 queryLoop 的信息，见
    // loop.ts todo gate 处的 producedSubstantialText），所以这里不做判定、只做
    // **不下无条件命令**：把祈使句降级为带条件的分流，让模型自己选。上游 gate 已
    // 有精确信号时会额外下发"禁止重述"约束，两层配合形成兜底。
    if (this.currentTodos.length === 0 && oldTodos.length > 0) {
      return {
        output:
          "所有任务已完成，清单已清空。\n" +
          "若执行结果**尚未**告知用户，请汇总后告知；若你在本轮/上一轮**已经完整输出过**结论（这次只是回头补标记），" +
          "则**不要重复输出**，一句话收尾即可。\n\n旧任务列表:\n" +
          formatTodoList(oldTodos),
      };
    }

    // 返回 diff（附上状态建议——写入已成功，建议不影响结果）
    const diff = formatTodoDiff(oldTodos, this.currentTodos);
    return {
      output: statusAdvisories.length > 0 ? `${diff}\n\n${statusAdvisories.join("\n")}` : diff,
    };
  }
}
