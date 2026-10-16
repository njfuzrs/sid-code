/**
 * 全局键位默认声明表 — K1（集中声明，替代散落硬编码）
 *
 * 复用 chord.ts 的 Keystroke 类型与 keystrokeMatches 匹配函数。
 * 后续 K2（用户自定义）/ K3（冲突检测）/ K4（帮助同步）/ K5（和弦集成）留好接口。
 */

import type { Keystroke } from "./chord.ts";
import type { Key } from "../contexts/KeypressContext.ts";
import { keystrokeMatches } from "./chord.ts";

/**
 * 帮助面板分组。顺序见 helpShortcuts.ts 的 HELP_GROUPS。
 * 分组的目的不是好看：同一张平铺表里「输出中才生效」「有后台任务才生效」的键
 * 和普通键混排，读者无从判断前提条件，这正是 ? 面板此前被读错的根因。
 */
export type HelpGroup = "input" | "submit" | "view" | "task" | "control";

/** 一条键位绑定声明 */
export interface KeyBinding {
  /** 动作 ID（唯一，后续 K2 用户配置按此 key 覆盖） */
  action: string;
  /** 触发按键（单键；和弦序列由 K5 处理，此处只 1 个） */
  stroke: Keystroke;
  /** 帮助文本里显示的按键名，如 "Ctrl+C"（K4 用） */
  display: string;
  /** 帮助文本描述（中文），如 "退出"（K4 用）。有前提条件的键必须把条件写进来。 */
  description: string;
  /** 是否在 ShortcutsHelp 里展示（有些键是内部用不展示） */
  showInHelp: boolean;
  /** 帮助面板分组；缺省归入 control。 */
  group?: HelpGroup;
  /**
   * 固定键：触发逻辑是 InputArea 里按字符 / 光标语义硬编码的，**不走 matchBinding 查表**。
   * 登记在表里只为帮助展示。用户在 keybindings.json 改绑它们不会改变行为，
   * 所以 validate 会拒绝这类改绑——否则帮助显示新键、按下去仍是旧键，帮助就在说谎。
   */
  fixed?: boolean;
}

/**
 * 全局键位默认声明表。
 * ⚠️ 这里只放 App.tsx 的全局键 + InputArea 键（仅用于帮助展示）。
 *     Dialog 局部键不在此（见 spec §2.4）。
 * ⚠️ 组内顺序 = ShortcutsHelp 展示顺序。
 */
export const DEFAULT_BINDINGS: KeyBinding[] = [
  // ── InputArea 键 ──
  // fixed 项（shellMode/filePicker/newline*/historyUpDown/killRingYank/emacsKillWord）是字符级/光标级输入，
  // 语义固定不走查表，仅登记供帮助展示；其余 input:* 已接入 InputArea 的 matchBinding 查表，可改绑。
  {
    action: "input:shellMode",
    stroke: { name: "!" },
    display: "!",
    description: "输入框为空时进入 shell 模式",
    showInHelp: true,
    group: "input",
    fixed: true,
  },
  {
    action: "input:filePicker",
    stroke: { name: "@" },
    display: "@",
    description: "选择文件/目录",
    showInHelp: true,
    group: "input",
    fixed: true,
  },
  {
    action: "input:newline",
    stroke: { shift: true, name: "enter" },
    display: "Shift+Enter",
    description: "换行（也可 Alt+Enter / Ctrl+J）",
    showInHelp: true,
    group: "input",
    fixed: true,
  },
  {
    action: "input:newlineAlt",
    stroke: { alt: true, name: "enter" },
    display: "Alt/Opt+Enter",
    description: "换行",
    showInHelp: false,
    group: "input",
    fixed: true,
  },
  {
    action: "input:newlineCtrlJ",
    stroke: { ctrl: true, name: "j" },
    display: "Ctrl+J",
    description: "换行",
    showInHelp: false,
    group: "input",
    fixed: true,
  },
  {
    action: "input:killRingYank",
    stroke: { ctrl: true, name: "y" },
    display: "Ctrl+Y",
    description: "yank（粘贴已删文本）",
    showInHelp: false,
    group: "input",
    fixed: true,
  },
  {
    action: "input:emacsKillWord",
    stroke: { ctrl: true, name: "w" },
    display: "Ctrl+W",
    description: "删除前一个词",
    showInHelp: false,
    group: "input",
    fixed: true,
  },
  {
    action: "input:historyUpDown",
    stroke: { name: "up" },
    display: "↑/↓",
    description: "翻输入历史（多行时移动光标）",
    showInHelp: true,
    group: "input",
    fixed: true,
  },
  // ↑ 只需注册 up，down 同理；display 合并展示
  {
    action: "input:reverseSearch",
    stroke: { ctrl: true, name: "r" },
    display: "Ctrl+R",
    description: "反向搜索历史",
    showInHelp: true,
    group: "input",
  },
  {
    action: "input:externalEditor",
    stroke: { ctrl: true, name: "g" },
    display: "Ctrl+G",
    description: "外部编辑器编辑输入",
    showInHelp: true,
    group: "input",
  },
  // P1-G6：流式响应中提交时选择排队优先级（对齐 CC now>next>later）。
  // 裸 Enter = next（默认排队）；Alt+N = now（本轮结束后最先发，开 mid-turn drain 时可抢占）；
  // Alt+L = later（排在所有 next 之后）。空闲态这两个键不拦截（无队列语义），照常插入字符。
  {
    action: "input:submitNow",
    stroke: { alt: true, name: "n" },
    display: "Alt+N",
    description: "提交并插队，最先发送",
    showInHelp: true,
    group: "submit",
  },
  {
    action: "input:submitLater",
    stroke: { alt: true, name: "l" },
    display: "Alt+L",
    description: "提交并延后，最后发送",
    showInHelp: true,
    group: "submit",
  },
  // ── App.tsx 全局键（实际触发也改为查表）──
  {
    action: "app:interrupt",
    stroke: { name: "escape" },
    display: "Esc",
    description: "中断模型输出 / 工具执行",
    showInHelp: true,
    group: "control",
  },
  {
    action: "app:quit",
    stroke: { ctrl: true, name: "c" },
    display: "Ctrl+C",
    description: "忙时中断；空闲时按两次退出",
    showInHelp: true,
    group: "control",
  },
  {
    action: "input:permMode",
    stroke: { shift: true, name: "tab" },
    display: "Shift+Tab",
    description: "切换权限模式",
    showInHelp: true,
    group: "control",
  },
  {
    action: "app:toggleThinking",
    stroke: { alt: true, name: "t" },
    display: "Alt+T",
    description: "切换扩展思考 (on/off)",
    showInHelp: true,
    group: "control",
  },
  {
    action: "app:toggleModel",
    stroke: { alt: true, name: "p" },
    display: "Alt+P",
    description: "切换模型（不清空输入）",
    showInHelp: true,
    group: "control",
  },
  {
    action: "app:toggleHeight",
    stroke: { ctrl: true, name: "o" },
    display: "Ctrl+O",
    description: "展开/收起折叠内容（工具结果 + 思考）",
    showInHelp: true,
    group: "view",
  },
  {
    action: "app:toggleCopyMode",
    stroke: { ctrl: true, name: "s" },
    display: "Ctrl+S",
    description: "复制模式：放开鼠标划选文本（仅全屏模式）",
    showInHelp: true,
    group: "view",
  },
  {
    action: "app:toggleMarkdown",
    stroke: { alt: true, name: "m" },
    display: "Alt+M",
    description: "切换 Markdown 渲染",
    showInHelp: true,
    group: "view",
  },
  {
    action: "app:clearScreen",
    stroke: { ctrl: true, name: "l" },
    display: "Ctrl+L",
    description: "清屏（保留历史）",
    showInHelp: true,
    group: "view",
  },
  {
    action: "app:dismissError",
    stroke: { ctrl: true, name: "e" },
    display: "Ctrl+E",
    description: "关闭错误面板（面板显示时）",
    showInHelp: true,
    group: "view",
  },
  // ── 后台任务：Ctrl+F / Ctrl+X / Ctrl+B 是上下文分层的，前提不满足时放行给输入框的 emacs 语义 ──
  {
    action: "app:toggleTaskPanel",
    stroke: { ctrl: true, name: "t" },
    display: "Ctrl+T",
    description: "显示/隐藏后台任务面板",
    showInHelp: true,
    group: "task",
  },
  {
    action: "app:killAllTasks",
    stroke: { ctrl: true, name: "f" },
    display: "Ctrl+F",
    description: "有后台任务时：终止全部（按两次确认）",
    showInHelp: true,
    group: "task",
  },
  // 对标 cc 的 context-sensitive x（stopOrDismissAgent）：面板有已完成条目时按它立即划掉，
  // 不必等驱逐缓冲期到点。只清终态、绝不碰 running——把还在跑的任务从面板划掉会造成
  // "条目不见了却还在烧 token"的黑盒（终止运行中任务的出口是 Ctrl+F / ESC）。
  // 无可划掉条目时不抢占按键，放行给输入框（同 Ctrl+F / Ctrl+B 的上下文分层）。
  {
    action: "app:dismissTasks",
    stroke: { ctrl: true, name: "x" },
    display: "Ctrl+X",
    description: "有已完成任务时：从面板划掉",
    showInHelp: true,
    group: "task",
  },
  {
    action: "app:backgroundTask",
    stroke: { ctrl: true, name: "b" },
    display: "Ctrl+B",
    description: "执行中：转入后台（tmux 下与 prefix 冲突）",
    showInHelp: true,
    group: "task",
  },
];

/**
 * 给定一次真实按键，返回命中的 binding（未命中返回 undefined）。
 * 遍历 DEFAULT_BINDINGS，用 keystrokeMatches 精确匹配 name + 修饰键。
 */
export function matchBinding(
  key: Key,
  bindings: KeyBinding[] = DEFAULT_BINDINGS,
): KeyBinding | undefined {
  return bindings.find((b) => keystrokeMatches(b.stroke, key));
}

/**
 * 给定 action ID，取出 binding（App.tsx handler 里按 action 判断用）。
 */
export function bindingFor(
  action: string,
  bindings: KeyBinding[] = DEFAULT_BINDINGS,
): KeyBinding | undefined {
  return bindings.find((b) => b.action === action);
}
