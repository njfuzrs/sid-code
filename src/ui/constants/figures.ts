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

/**
 * 聚焦指针（实心三角，比 ARROW_PROMPT 更重）。用于左右分栏列表里标记「当前聚焦项」，
 * 与「已选中」区分开：聚焦=光标停留处（驱动右侧预览切换），选中=已提交的答案。
 * 对标 cc 的 figures.pointer。
 */
export const POINTER = "▸";

/** 警告标记（与 ✔/✘ 同族的纤细字形，用于内联警告前缀） */
export const WARNING_MARK = "⚠";

/**
 * 重试 / 降级 / 暂停标记（瞬态状态前缀，仅靠颜色区分语义）。
 * 此前散落在 RetryStatus / ToolStatus 内联字符串里写死，违反 L1.1「字形从 figures.ts 取」，已收口。
 * - RETRY_MARK    ⟳ 旋转箭头：请求重试 / 正在重试中
 * - FALLBACK_MARK ↘ 下降箭头：已降级到备用模型
 * - PAUSED_MARK   ⏸ 暂停：流式跟随已暂停
 */
export const RETRY_MARK = "⟳";
export const FALLBACK_MARK = "↘";
export const PAUSED_MARK = "⏸";

/** 流式输出光标（块状），逐字渲染时跟在已输出文本尾部 */
export const CURSOR = "▌";

/** trailing 指示箭头（指向行尾的补充信息，如「当前/最新」标记） */
export const ARROW_TRAILING = "←";

/**
 * 底部状态栏 Token 计数方向箭头（↑ 输入 / ↓ 输出）。
 * 对标 claude-code 的 status line 视觉语言：`↑ 12.4k ↓ 8.2k`，
 * 单色几何字形，一眼可辨流向且省空间。
 */
export const TOKEN_IN = "↑";
export const TOKEN_OUT = "↓";

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

/**
 * 运行中任务的旋转动画帧（后台任务面板用）。
 *
 * 沿用 TODO_IN_PROGRESS 的 ◐ 半填字形族，逐帧旋转四个象限形成「转动」感——
 * 与静态 ◐ 同构（都是半填圆），靠位置变化表达「活着、在动」，不引入粗细不一的杂字形。
 * a11y 模式下不取帧、直接用静态 ◐（屏幕阅读器会把逐帧字符变化读成噪声，须完全关动画）。
 */
export const TASK_SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];

/**
 * 任务被用户终止（killed）的标记：⊘ 圆形加斜杠 = 取消/中止。
 *
 * 与 ● 完成、✘ 失败 形状各异，靠「字形 + 颜色」双通道区分三种终态——
 * 此前 killed 复用 ● 仅靠颜色区分,色盲/低对比终端下与 completed 无法分辨(违反双通道原则)。
 */
export const TASK_KILLED_MARK = "⊘";

/**
 * 终端窗口标题状态前缀（写入 OSC 0 标题,非屏幕渲染,但同样禁彩色 emoji——
 * emoji 在 tab/title 栏跨终端占位不一,且与单色字形语言冲突。对标 claude-code
 * REPL.tsx 的 TITLE_STATIC_PREFIX / TITLE_ANIMATION_FRAMES）。
 *
 * - TITLE_STATIC_PREFIX     ✳ 常驻星号：任务完成 / 中断 / 等待确认 / 空闲——「这个窗口有过会话」。
 * - TITLE_ANIMATION_FRAMES  ⠂⠐ 盲文点交替：任务进行中,逐帧切换形成「跳动」感。
 *
 * 用户诉求原文：小圆点代表进行中,小星号代表任务结束或中断。这里用
 * 动画点(进行中) vs 静态星(结束/中断)落地该语义,且全为单色几何字形。
 */
export const TITLE_STATIC_PREFIX = "✳";
export const TITLE_ANIMATION_FRAMES = ["⠂", "⠐"];

/**
 * 状态栏「推理强度档位」字形（effort 列）。
 *
 * 遵循 L1.1 元原则「同族递进」：用同一字形族的**填充度**表达 4 档强度递进，
 * 不为每档引入新形状。沿用进度/电量语义的方块填充族 ▁▃▅█（低→高，柱状升高），
 * 一眼可辨档位高低，且与 ▰▱ 进度族同构、单色几何、跨终端占位稳定。
 *
 * auto 态不取这里的字形，单独用 ◌（空心点，表示「未定/跟随默认」），见 useStatusLineData。
 */
export const EFFORT_LOW = "▁";
export const EFFORT_MEDIUM = "▃";
export const EFFORT_HIGH = "▅";
export const EFFORT_MAX = "█";
/** effort auto 态字形（未显式设档，跟随模型默认）。空心点 = 「未定」。 */
export const EFFORT_AUTO = "◌";

/** 档位 → 字形映射（供 useStatusLineData 取用，避免渲染层硬编码）。 */
export const EFFORT_GLYPHS: Record<"low" | "medium" | "high" | "max", string> = {
  low: EFFORT_LOW,
  medium: EFFORT_MEDIUM,
  high: EFFORT_HIGH,
  max: EFFORT_MAX,
};

/**
 * 状态栏「思考开关」字形（thinking 列）。复用思考过程标记 ✻ 字形族：
 * - 开启：✻（实心星，与消息流思考标记同构，语义一致）。
 * - 关闭：✧（空心星，同族不同填充，表「思考已关」）。
 * 靠填充度区分开/关，不引入异形字。
 */
export const THINKING_ON = "✻";
export const THINKING_OFF = "✧";
