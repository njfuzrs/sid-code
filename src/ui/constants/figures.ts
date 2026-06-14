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
