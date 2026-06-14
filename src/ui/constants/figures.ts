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
