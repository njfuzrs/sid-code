/**
 * `?` 快捷键面板的数据与布局（纯函数，可单测）
 *
 * 面板内容 = 运行时键位表里 showInHelp 的项 + 本文件的 HELP_ONLY_SHORTCUTS。
 *
 * 为什么要有 HELP_ONLY_SHORTCUTS：Emacs 编辑键、补全、滚动、Esc Esc、Ctrl+D 等是在
 * InputArea / ScrollableList / App 里按字符或上下文硬编码的，不走 matchBinding，
 * 也不可改绑。此前面板只读 DEFAULT_BINDINGS，这一整批真实可用的键在面板里不存在。
 * 它们只用于展示，**不参与匹配**，所以不放进 DEFAULT_BINDINGS（放进去会让
 * 「stroke 全表唯一」「往返命中自身」这些表级不变量失去意义）。
 */

import { stringWidth } from "../render-port/text.ts";
import type { HelpGroup, KeyBinding } from "./defaultBindings.ts";

export interface HelpItem {
  key: string;
  description: string;
}

export interface HelpSection {
  group: HelpGroup;
  title: string;
  items: HelpItem[];
}

/** 分组顺序与标题。条件性生效的组把条件写进标题，组内描述就不必每条重复。 */
export const HELP_GROUPS: ReadonlyArray<{ group: HelpGroup; title: string }> = [
  { group: "input", title: "输入编辑" },
  { group: "submit", title: "发送与排队（Alt+N / Alt+L 仅在输出中生效）" },
  { group: "control", title: "会话控制" },
  { group: "view", title: "显示" },
  { group: "task", title: "后台任务（Ctrl+F / X / B 无对应任务时照常编辑输入）" },
];

/** 不走查表、不可改绑、仅供展示的键。每条都对应一处真实实现（见行尾注释）。 */
export const HELP_ONLY_SHORTCUTS: ReadonlyArray<HelpItem & { group: HelpGroup }> = [
  { group: "input", key: "Tab", description: "补全时回填选中项" }, // InputArea 补全分支
  { group: "input", key: "Ctrl+A/E/B/F", description: "行首/行尾/左移/右移" }, // InputArea Emacs Ctrl 分支
  { group: "input", key: "Alt+B/F", description: "按词左/右移（同 Alt+←/→）" }, // InputArea Alt 词移
  { group: "input", key: "Ctrl+K/U/W", description: "删到行尾/行首/前一词" }, // killLine / killToStart / killWordBefore
  { group: "input", key: "Ctrl+Y/Alt+Y", description: "粘回已删文本/更早的" }, // yank / yankPop
  { group: "submit", key: "Enter", description: "发送（输出中则排队）" }, // 裸 Enter → handleSubmit
  { group: "submit", key: "↑", description: "空输入时弹回排队消息" }, // onPopQueuedForEdit
  { group: "control", key: "Esc Esc", description: "空闲时打开会话回退" }, // App escape-escape
  { group: "control", key: "Ctrl+D", description: "删后一字；空输入按两次退出" }, // InputArea Ctrl+D
  { group: "control", key: "?", description: "显示/隐藏本面板" }, // isShortcutsHelpTrigger
  { group: "view", key: "PgUp/PgDn", description: "对话区翻页（全屏）" }, // ScrollableList
  { group: "view", key: "Shift+↑/↓", description: "对话区逐行滚（全屏）" }, // ScrollableList
];

/** 合并运行时键位表与仅展示项，按 HELP_GROUPS 分组。空组不输出。 */
export function buildHelpSections(bindings: KeyBinding[]): HelpSection[] {
  return HELP_GROUPS.map(({ group, title }) => ({
    group,
    title,
    items: [
      ...bindings
        .filter((b) => b.showInHelp && (b.group ?? "control") === group)
        .map((b) => ({ key: b.display, description: b.description })),
      ...HELP_ONLY_SHORTCUTS.filter((s) => s.group === group).map(({ key, description }) => ({
        key,
        description,
      })),
    ],
  })).filter((s) => s.items.length > 0);
}

/** 列间距（列宽之外的右侧留白）。 */
export const HELP_COLUMN_GAP = 2;
/** 面板左右内边距之和（ShortcutsHelp 的 paddingLeft=1 + paddingRight=2）。 */
export const HELP_HORIZONTAL_PADDING = 3;
const MAX_COLUMNS = 3;

export interface HelpLayout {
  columns: number;
  /** 每列总宽（含间距）。 */
  columnWidth: number;
  /** 按键列宽（同一面板内对齐）。 */
  keyWidth: number;
}

/**
 * 按内容实测宽度选列数：取「最宽一条也不折行」的最多列数。
 *
 * 此前固定 33% 列宽，CJK 描述在 120 列终端里被截成「…（双击确认」+ 下一行孤零零的「）」。
 * 宁可少一列，也不让描述折行——折行后读者分不清续行属于哪一条。
 * 只有一列仍放不下时（极窄终端或用户自定义了超长描述）才允许折行。
 */
export function computeHelpLayout(sections: HelpSection[], termWidth: number): HelpLayout {
  const items = sections.flatMap((s) => s.items);
  const keyWidth = Math.max(1, ...items.map((i) => stringWidth(i.key)));
  const descWidth = Math.max(1, ...items.map((i) => stringWidth(i.description)));
  const entryWidth = keyWidth + 1 + descWidth + HELP_COLUMN_GAP;
  const available = Math.max(1, termWidth - HELP_HORIZONTAL_PADDING);
  const columns = Math.max(1, Math.min(MAX_COLUMNS, Math.floor(available / entryWidth)));
  return { columns, columnWidth: Math.floor(available / columns), keyWidth };
}

/**
 * `?` 是否应切换快捷键面板：只在输入框为空、非输出中、按下的是可插入的 `?` 时。
 *
 * 此前判定写在 Composer 里，拿不到输入框内容（注释自承"无法直接判断"），
 * 结果在句中打 `what?` 也会弹出面板，且 `?` 不被消费、照样插进输入框。
 */
export function isShortcutsHelpTrigger(
  key: { insertable?: boolean; sequence?: string; ctrl?: boolean; alt?: boolean },
  inputEmpty: boolean,
  isLoading: boolean,
): boolean {
  return (
    !isLoading && inputEmpty && !!key.insertable && !key.ctrl && !key.alt && key.sequence === "?"
  );
}
