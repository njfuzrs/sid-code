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
          activeForm: z.string().describe("进行时形式，如 '正在新增 crash-marker.ts'"),
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

function formatTodoDiff(oldTodos: TodoItem[], newTodos: TodoItem[]): string {
  const lines: string[] = [];
  lines.push("任务清单已更新:\n");
  lines.push("更新后:");
  lines.push(formatTodoList(newTodos));

  // 检测状态变更
  for (let i = 0; i < newTodos.length; i++) {
    const n = newTodos[i];
    const o = oldTodos[i];
    if (!o) continue;
    if (o.status !== n.status && n.status === "completed") {
      lines.push(`\n✅ 已完成: ${n.content}`);
    }
  }

  // 统计
  const completed = newTodos.filter(t => t.status === "completed").length;
  const inProgress = newTodos.filter(t => t.status === "in_progress").length;
  const pending = newTodos.filter(t => t.status === "pending").length;
  lines.push(`\n进度: ${completed}/${newTodos.length} 已完成` +
    (inProgress > 0 ? `, ${inProgress} 进行中` : "") +
    (pending > 0 ? `, ${pending} 待开始` : ""));

  return lines.join("\n");
}

const VALID_STATUSES = new Set(["pending", "in_progress", "completed"]);

export class TodoWriteTool implements Tool {
  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = todoWriteSchema();

  /** P2-3：状态管理类工具，清单内容随进展自然变化、连续更新是正当行为，豁免循环检测 */
  readonly exemptFromLoopDetection = true;

  private currentTodos: TodoItem[] = [];
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
    return this.currentTodos.map(t => ({ ...t }));
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
   */
  serialize(): { todos: TodoItem[] } {
    return { todos: this.currentTodos.map((t) => ({ ...t })) };
  }

  /**
   * 从持久化快照回灌 todo 清单（resume 恢复路径调用）。
   *
   * 容错：快照缺字段/类型不符/status 非法时，跳过该项而非抛错——绝不因脏快照阻断恢复。
   * 直接覆盖 currentTodos（resume 时本就是空实例，覆盖等价于"继续之前的清单"）。
   * 不触碰 writeVersion（保持从 0 起的时序基准语义）。
   */
  hydrate(snapshot: { todos?: unknown } | undefined | null): void {
    if (!snapshot || typeof snapshot !== "object") return;
    const raw = (snapshot as { todos?: unknown }).todos;
    if (!Array.isArray(raw)) return;
    const restored: TodoItem[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const t = item as Partial<TodoItem>;
      if (typeof t.content !== "string" || !t.content.trim()) continue;
      if (typeof t.activeForm !== "string" || !t.activeForm.trim()) continue;
      if (typeof t.status !== "string" || !VALID_STATUSES.has(t.status)) continue;
      restored.push({ content: t.content, activeForm: t.activeForm, status: t.status });
    }
    this.currentTodos = restored;
  }

  async execute(input: unknown, _signal?: AbortSignal): Promise<ToolResult> {
    const params = input as { todos?: unknown };

    // 校验 todos 是数组
    if (!Array.isArray(params?.todos)) {
      return {
        output: "todos 必须是数组。格式: { todos: [{ content, activeForm, status }] }",
        isError: true,
      };
    }

    const todos = params.todos as TodoItem[];

    // 校验每个 todo 项
    for (let i = 0; i < todos.length; i++) {
      const t = todos[i];
      if (!t || typeof t.content !== "string" || !t.content.trim()) {
        return {
          output: `第 ${i + 1} 个 todo 项缺少有效的 content 字段`,
          isError: true,
        };
      }
      if (typeof t.activeForm !== "string" || !t.activeForm.trim()) {
        return {
          output: `第 ${i + 1} 个 todo 项缺少有效的 activeForm 字段`,
          isError: true,
        };
      }
      if (!VALID_STATUSES.has(t.status)) {
        return {
          output: `第 ${i + 1} 个 todo 项的 status 无效: "${t.status}"。有效值: pending, in_progress, completed`,
          isError: true,
        };
      }
    }

    // 检查全部完成（必须在 in_progress 校验之前，否则 [{completed}, {completed}] 会被误杀）
    const allDone = todos.length > 0 && todos.every(t => t.status === "completed");

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
    const statusAdvisories: string[] = [];
    if (!allDone) {
      const inProgressCount = todos.filter(t => t.status === "in_progress").length;
      const hasNonPending = todos.some(t => t.status !== "pending");
      if (inProgressCount > 1) {
        statusAdvisories.push(
          `提示：当前有 ${inProgressCount} 个 in_progress。清单已按你提交的内容保存，但建议同一时刻只保留 1 个 in_progress、其余置 pending——这样进度展示更清晰，也更容易发现自己是否在并行摊开太多任务。`,
        );
      } else if (hasNonPending && inProgressCount === 0) {
        statusAdvisories.push(
          "提示：当前没有 in_progress 任务。清单已保存，但若你正要继续推进，记得把下一项置为 in_progress。",
        );
      }
    }

    // 保存旧状态
    const oldTodos = [...this.currentTodos];

    // 校验通过、即将更新状态 → 记一次成功写入（P0-2 回注判定用）
    this.writeVersion++;

    // 更新为新状态（全量替换）
    this.currentTodos = allDone ? [] : todos;

    // 空列表检测
    if (this.currentTodos.length === 0 && oldTodos.length > 0) {
      return {
        output: "所有任务已完成。请汇总执行结果并告知用户。\n\n旧任务列表:\n" + formatTodoList(oldTodos),
      };
    }

    // 返回 diff（附上状态建议——写入已成功，建议不影响结果）
    const diff = formatTodoDiff(oldTodos, this.currentTodos);
    return {
      output: statusAdvisories.length > 0
        ? `${diff}\n\n${statusAdvisories.join("\n")}`
        : diff,
    };
  }
}
