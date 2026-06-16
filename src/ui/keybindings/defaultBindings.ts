/**
 * 全局键位默认声明表 — K1（集中声明，替代散落硬编码）
 *
 * 复用 chord.ts 的 Keystroke 类型与 keystrokeMatches 匹配函数。
 * 后续 K2（用户自定义）/ K3（冲突检测）/ K4（帮助同步）/ K5（和弦集成）留好接口。
 */

import type { Keystroke } from "./chord.ts";
import type { Key } from "../contexts/KeypressContext.ts";
import { keystrokeMatches } from "./chord.ts";

/** 一条键位绑定声明 */
export interface KeyBinding {
  /** 动作 ID（唯一，后续 K2 用户配置按此 key 覆盖） */
  action: string;
  /** 触发按键（单键；和弦序列由 K5 处理，此处只 1 个） */
  stroke: Keystroke;
  /** 帮助文本里显示的按键名，如 "Ctrl+C"（K4 用） */
  display: string;
  /** 帮助文本描述（中文），如 "退出"（K4 用） */
  description: string;
  /** 是否在 ShortcutsHelp 里展示（有些键是内部用不展示） */
  showInHelp: boolean;
}

/**
 * 全局键位默认声明表。
 * ⚠️ 这里只放 App.tsx 的全局键 + InputArea 键（仅用于帮助展示）。
 *     Dialog 局部键不在此（见 spec §2.4）。
 * ⚠️ 顺序 = ShortcutsHelp 展示顺序。
 */
export const DEFAULT_BINDINGS: KeyBinding[] = [
  // ── InputArea 键 ──
  // shellMode/filePicker/newline/historyUpDown 是字符级/光标级输入,语义固定不走查表(仅登记供帮助展示);
  // reverseSearch/permMode 已接入 InputArea 的 matchBinding 查表(K1),用户在 keybindings.json 改这些 action 即生效。
  { action: "input:shellMode",     stroke: { name: "!" },             display: "!",           description: "shell 模式",        showInHelp: true },
  { action: "input:filePicker",    stroke: { name: "@" },             display: "@",           description: "选择文件/目录",     showInHelp: true },
  { action: "input:newline",       stroke: { shift: true, name: "enter" }, display: "Shift+Enter", description: "多行输入",    showInHelp: true },
  // ── App.tsx 全局键（实际触发也改为查表）──
  { action: "app:toggleCopyMode",  stroke: { ctrl: true, name: "s" }, display: "Ctrl+S",     description: "Copy Mode",          showInHelp: true },
  { action: "app:toggleMarkdown",  stroke: { alt: true,  name: "m" }, display: "Alt+M",      description: "切换 Markdown 渲染", showInHelp: true },
  { action: "app:toggleHeight",    stroke: { ctrl: true, name: "o" }, display: "Ctrl+O",     description: "展开/收起折叠内容（工具结果 + 思考）", showInHelp: true },
  { action: "input:historyUpDown", stroke: { name: "up" },           display: "↑/↓",         description: "输入历史",           showInHelp: true },
  // ↑ 只需注册 up，down 同理；display 合并展示
  { action: "input:reverseSearch", stroke: { ctrl: true, name: "r" }, display: "Ctrl+R",     description: "反向搜索历史",       showInHelp: true },
  { action: "app:quit",            stroke: { ctrl: true, name: "c" }, display: "Ctrl+C",     description: "退出",               showInHelp: true },
  { action: "app:interrupt",       stroke: { name: "escape" },        display: "Esc",         description: "取消当前操作",       showInHelp: true },
  { action: "input:permMode",      stroke: { shift: true, name: "tab" }, display: "Shift+Tab", description: "切换权限模式",     showInHelp: true },
];

/**
 * 给定一次真实按键，返回命中的 binding（未命中返回 undefined）。
 * 遍历 DEFAULT_BINDINGS，用 keystrokeMatches 精确匹配 name + 修饰键。
 */
export function matchBinding(key: Key, bindings: KeyBinding[] = DEFAULT_BINDINGS): KeyBinding | undefined {
  return bindings.find((b) => keystrokeMatches(b.stroke, key));
}

/**
 * 给定 action ID，取出 binding（App.tsx handler 里按 action 判断用）。
 */
export function bindingFor(action: string, bindings: KeyBinding[] = DEFAULT_BINDINGS): KeyBinding | undefined {
  return bindings.find((b) => b.action === action);
}
