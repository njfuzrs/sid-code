/**
 * AskUserQuestion 工具
 *
 * 让模型在需要用户决策时，向用户抛出**结构化选择题**（而非在正文里夹一句问话等用户
 * 自由回答）：每题 2-4 个候选项，用户用键盘选择，答案结构化回灌给模型。适用于
 * 方案选型、歧义澄清、关键取舍等"继续往下做之前必须由人拍板"的场景。
 *
 * 设计对标 claude-code src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx：
 * - shouldDefer：长尾低频工具，由 ToolSearch 按需调出，不占首轮上下文。
 * - 交互通过 ask-user-question-bridge 唤起 TUI 弹窗（headless 模式自动降级）。
 * - 结果格式化为 `「问题」→「答案」` 文本回灌模型，多选答案以 ", " 连接。
 *
 * fix_type: new_module
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";
import {
  askUserQuestion,
  type AskQuestion,
} from "./ask-user-question-bridge.ts";

/** 单题最多候选项数（对标 cc 的 2-4） */
const MAX_OPTIONS = 4;
const MIN_OPTIONS = 2;
/** 一次最多提问数（对标 cc 的 1-4） */
const MAX_QUESTIONS = 4;

const askUserQuestionSchema = lazySchema(() =>
  z.object({
    questions: z
      .array(
        z.object({
          question: z
            .string()
            .describe("完整问题文本，应以问号结尾，清晰具体"),
          header: z
            .string()
            .describe("极短标签（≤12 字符），作为该问题的分类 chip 显示，如 '认证方式' '数据库'"),
          options: z
            .array(
              z.object({
                label: z.string().describe("选项显示文本（1-5 词，简洁且互斥）"),
                description: z
                  .string()
                  .optional()
                  .describe("该选项的说明或权衡解释（可选）"),
                preview: z
                  .string()
                  .optional()
                  .describe(
                    "选项预览内容（可选，仅单选题生效）。用 markdown / ASCII mockup / 代码片段展示该选项对应的具体产物，供用户可视化对比。选中该项时在右侧并排渲染。仅在用户需要「看到实物才能决策」时提供（如对比两种 UI 布局、两段实现代码），简单偏好题不要用。",
                  ),
              }),
            )
            .min(MIN_OPTIONS)
            .max(MAX_OPTIONS)
            .describe(`${MIN_OPTIONS}-${MAX_OPTIONS} 个候选项。无需提供"其他"选项——UI 会自动追加，允许用户自定义输入`),
          multi_select: z
            .boolean()
            .optional()
            .describe("是否允许多选（选项之间不互斥时设为 true，默认 false）"),
        }),
      )
      .min(1)
      .max(MAX_QUESTIONS)
      .describe(`要向用户提出的问题列表（1-${MAX_QUESTIONS} 个）`),
  }),
);

export class AskUserQuestionTool implements Tool {
  readonly zodSchema = askUserQuestionSchema();
  /**
   * 首轮常驻可见（alwaysLoad），不进延迟池。
   *
   * 对标 claude-code 的 alwaysLoad 语义：ToolSearch 启用时仍把完整 schema 发进首轮
   * 上下文，无需一轮 tool_search 往返即可正确调用。
   *
   * 为什么不 shouldDefer——尽管本工具确实"低频"，但它是 /commit、/commit-push-pr 等
   * 内置流程的**刚需**：这些流程的提示词直接点名要求「用 ask_user_question 弹结构化选项」。
   * 若延迟加载，模型看到工具名却没看到 schema，会凭记忆猜参数结构直接盲调（实测把
   * `questions: [...]` 猜成 `answers: [...]`），触发参数校验失败→再 tool_search 激活→重试，
   * 白白多绕一轮。交互类刚需工具首轮直出，省掉这一轮盲调 churn，代价仅首轮多约几百 token。
   *
   * 注意：不再声明 shouldDefer——alwaysLoad 与 shouldDefer 语义互斥（registry.isToolDeferred
   * 里 alwaysLoad 优先级最高会直接 return false），同时声明只会造成阅读困惑。
   */
  readonly alwaysLoad = true;
  readonly searchHint = "ask user question choice clarify decision 提问 选择 澄清 决策 选型";

  name(): string {
    return "ask_user_question";
  }

  description(): string {
    return `向用户提出结构化选择题，收集决策。当你遇到只有用户能拍板的关键岔路口时使用——而不是在回复正文里夹一句问话。

## 何时使用
- 方案选型：多种合理实现路径，需要用户选一种（如 OAuth vs JWT、Redis vs 内存缓存）
- 歧义澄清：需求有多种理解，继续做之前必须确认
- 关键取舍：性能/可维护性/工期等维度需要用户权衡
- 范围确认：要改动的边界不清晰，需用户圈定

## 何时不使用
- 你能从代码/上下文/常理推断出合理默认 → 直接做，事后说明，别打断用户
- 只是想确认"我这样做对吗" → 不要为寻求认可而提问
- 信息查询类问题 → 自己查（读代码 / 搜索 / 联网），不要问用户
- 纯偏好且有约定俗成默认（命名/格式/默认值）→ 选合理项并注明

## 用法
- 一次可提 1-4 个问题，每题 2-4 个候选项。
- 每个选项给简短 label + 可选 description（解释这个选项意味着什么、有何权衡）。
- 若推荐某个选项，把它放在第一个，并在 label 末尾标注"(推荐)"。
- 选项之间不互斥时设 multi_select: true（允许用户多选）。
- 无需提供"其他"选项——UI 会自动追加，允许用户自定义输入。
- 用户可以给选择附加自由备注（notes），备注会连同答案一起回灌给你。

## preview 预览功能
当选项代表用户需要**看到实物才能对比**的具体产物时（如两种 UI 布局 ASCII mockup、两段代码实现、两种配置方案），给 option 的 \`preview\` 字段填入 markdown 内容。UI 会切换为左右分栏：左侧选项列表，右侧渲染当前聚焦选项的 preview。
- 仅单选题（非 multi_select）生效。
- 多行文本和换行符正常渲染。
- 不要为简单偏好题使用 preview——label + description 足矣时别浪费屏幕空间。

用户作答后，答案会以"问题 → 答案"的形式回灌给你（若用户附加了备注，会追加在答案后）。请严格按用户的选择继续，不要无视用户的决策。`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(askUserQuestionSchema()) as Record<string, unknown>;
  }

  /** 只读：不改动任何文件 / 状态，仅收集用户输入 */
  readOnly(): boolean {
    return true;
  }

  /**
   * 非并发安全：交互式弹窗必须独占——多个提问同时弹出会争抢键盘焦点、互相覆盖。
   * 串行执行保证一次只弹一个问卷。
   */
  isConcurrencySafe(): boolean {
    return false;
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const params = input as { questions?: AskQuestion[] };

    if (!Array.isArray(params?.questions) || params.questions.length === 0) {
      return {
        output:
          "questions 必须是非空数组。格式: { questions: [{ question, header, options: [{ label, description? }], multi_select? }] }",
        isError: true,
      };
    }

    const result = await askUserQuestion({ questions: params.questions }, signal);

    if (result.status === "unavailable") {
      // headless/SDK/CI 模式：无交互通道。明确告知模型"无法向用户提问"，
      // 让它退回到自行选择最合理默认并继续，而不是误以为用户拒绝或卡住。
      return {
        output:
          "当前运行环境无法向用户提问（非交互模式 / 无 TUI）。请基于现有上下文选择最合理的默认方案继续推进，并在最终回复中说明你的选择与理由。",
        isError: false,
      };
    }

    if (result.status === "cancelled") {
      return {
        output:
          "用户取消了回答（未作选择）。请不要重复追问同样的问题；基于现有信息选择最合理的默认方案继续，或在回复中说明你需要的信息。",
        isError: false,
      };
    }

    // answered：把"问题 → 答案（备注）"格式化回灌模型
    return {
      output: formatAnsweredOutput(params.questions, result.answers, result.notes),
    };
  }
}

/**
 * 把用户作答结果格式化为回灌模型的文本。抽成纯函数便于单测。
 *
 * 格式：每题一行 `· {question} → {answer}`；若该题有非空备注，追加 `（备注：{notes}）`。
 */
export function formatAnsweredOutput(
  questions: AskQuestion[],
  answers: Record<string, string>,
  notes?: Record<string, string>,
): string {
  const lines: string[] = ["用户已作答："];
  for (const q of questions) {
    const answer = answers[q.question];
    const note = notes?.[q.question]?.trim();
    const noteSuffix = note ? `（备注：${note}）` : "";
    lines.push(`· ${q.question} → ${answer ?? "(未作答)"}${noteSuffix}`);
  }
  return lines.join("\n");
}
