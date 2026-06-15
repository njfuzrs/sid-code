/**
 * TUI 符号常量（集中定义，避免散落硬编码）
 *
 * 视觉语言对标 claude-code：消息流靠「状态色 bullet + 树枝缩进 + 留白」构成节奏，
 * 不再用盒子边框包裹工具调用。所有行首符号统一从这里取。
 *
 * 参考 claude-code/src/constants/figures.ts
 */

/** macOS 的 ⏺ 垂直对齐更好；其它平台部分字体不支持，回退到 ● */
const isDarwin = process.platform === "darwin";

/** 工具 / assistant 行首状态圆点（仅靠颜色区分状态，字形统一） */
export const BULLET = isDarwin ? "⏺" : "●";

/** 结果 / 子项树枝缩进前缀（结果区行首） */
export const TREE_BRANCH = "⎿";

/** 用户输入行首前缀 */
export const USER_PROMPT = ">";

/** 思考过程标记 */
export const THINKING_MARK = "✻";

/**
 * 状态字形（统一收口，仅靠颜色区分语义，字形保持视觉一致）。
 *
 * 此前 ✓ / ✗ / ✕ / ● 散落在 Composer / ToolStatus / ErrorMessage 各处，
 * 连「叉」都有 ✗ 和 ✕ 两种粗细不一的写法，是凌乱感的来源之一。
 * 统一后:
 * - 成功/错误用同一对纤细字形 ✔ / ✘（笔画粗细一致，比 ✓✕ 更协调）
 * - 行首引导箭头 › 与欢迎屏、hint 消息同构
 */
export const SUCCESS_MARK = "✔";
export const ERROR_MARK = "✘";
export const ARROW_PROMPT = "›";

/** 警告标记（与 ✔/✘ 同族的纤细字形，用于内联警告前缀） */
export const WARNING_MARK = "⚠";

/** 流式输出光标（块状），逐字渲染时跟在已输出文本尾部 */
export const CURSOR = "▌";

/** trailing 指示箭头（指向行尾的补充信息，如「当前/最新」标记） */
export const ARROW_TRAILING = "←";

/**
 * 计划审批标记。复用 BULLET 字形族(实心圆点)，靠颜色点睛而非引入新字形。
 * 此前曾用 📋 彩色 emoji,违反「单色几何字形」原则,已收口至此。
 */
export const PLAN_REVIEW = BULLET;

/**
 * Todo / 任务清单 checkbox 字形（同一字形族，靠「填充度」表达状态递进）。
 * ○ 空心=待办 → ◐ 半填=进行中 → ● 实心=完成。
 * 比 ⬜✅🔄 emoji 占位稳定、与 ⏺ bullet 语言同构。
 */
export const TODO_PENDING = "○";
export const TODO_IN_PROGRESS = "◐";
export const TODO_COMPLETED = "●";

/** 进度条字形：▰ 实心(已完成) / ▱ 空心(未完成) */
export const PROGRESS_FILLED = "▰";
export const PROGRESS_EMPTY = "▱";
