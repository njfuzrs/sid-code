/**
 * 带快捷键的可选项列表——确认类弹窗（权限 / Shell 确认）的选择控件。
 *
 * 解决的问题：确认框原先**只能敲字母**（y/n/a），没有光标、没有 ↑↓、Enter 不生效。
 * 用户在 ask_user_question 那边已经习惯了「↑↓ 选、Enter 确认」，到确认框却要回忆字母，
 * 是同一个 TUI 里两套交互模型。本组件把两边统一：**方向键可选 + Enter 确认 + 字母/数字直达**，
 * 三条路径并存，谁都不用记。
 *
 * 为什么不复用 shared/BaseSelectionList（沿用 ModelDialog 记录不复用理由的先例）：
 * ① 它不支持**字母**快捷键，而 y/n/a 是既有肌肉记忆 + 官网文档写明的契约，不能丢；
 * ② 大小写敏感的 `A`（Shift+A 持久档）与 `a`（会话档）是两个决策，需要 shift 参与匹配；
 * ③ 每项要按语义上色（允许绿 / 拒绝红 / 会话黄 / 持久蓝），BaseSelectionList 的
 *    titleColor 只有「焦点/禁用」两态；
 * ④ 补一个平级的 useKeypress 来加字母键会与它内部的 Critical handler 同优先级竞争，
 *    命中顺序取决于注册顺序（KeypressContext 的 broadcast 按 reverse 注册序遍历），太脆。
 * 一个 80 行的专用组件比在通用组件上开四个口子更好维护。
 *
 * 视觉遵循 src/ui/CLAUDE.md：字形从 figures.ts 取（POINTER / RADIO_*），颜色走 theme 语义 token，
 * 焦点态用「指针字形 + 加粗 + 品牌色」多通道表达（L2.1 双通道原则，不只靠颜色）。
 */

import React, { useState } from "react";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import type { Color } from "@sid-code/tui-renderer/styles.ts";
import { useKeypress, KeypressPriority, type Key } from "../../contexts/KeypressContext.tsx";
import { theme } from "../../semantic-colors.ts";
import { POINTER, RADIO_EMPTY, RADIO_SELECTED } from "../../constants/figures.ts";
import { resolveChoiceKey, type ChoiceTone, type HotkeyChoice } from "../permission-choices.ts";

/** 语义色角色 → theme token。集中一处，避免各弹窗各写一遍映射。 */
function toneColor(tone: ChoiceTone): Color {
  switch (tone) {
    case "allow":
      return theme.status.success;
    case "deny":
      return theme.status.error;
    case "session":
      return theme.status.warning;
    case "persist":
      return theme.ui.active;
  }
}

/** 提示行文案。抽成导出的纯函数便于单测锁文案契约。 */
export function choiceListHint(hotkeys: readonly string[]): string {
  return `↑↓ 选择 · Enter 确认 · ${hotkeys.join("/")} 直达 · Esc 取消`;
}

export interface HotkeyChoiceListProps<T> {
  choices: ReadonlyArray<HotkeyChoice<T>>;
  /** 光标初始落点（危险操作传「拒绝」的下标，实现安全默认） */
  initialIndex?: number;
  /** 选定回调。组件本身不做去重，由调用方 resolvedRef 保证只 resolve 一次。 */
  onSelect: (value: T) => void;
  /**
   * Esc 的语义值。确认类弹窗必须给——Esc 是终端里「我不想选」的通用出口，
   * 不给的话用户只能靠 Ctrl+C 退出整个会话（src/ui/CLAUDE.md L4-B：中断要给出路）。
   * 传 undefined 表示不处理 Esc（此时 Esc 交给外层）。
   */
  escapeValue?: T;
}

export function HotkeyChoiceList<T>({
  choices,
  initialIndex = 0,
  onSelect,
  escapeValue,
}: HotkeyChoiceListProps<T>): React.JSX.Element {
  const [cursor, setCursor] = useState(initialIndex);

  // 键盘决策全部委托给 resolveChoiceKey（纯函数、可单测）。组件这里只做副作用：
  // 移光标 / 回灌选择。判定顺序的坑（导航必须先于 insertable 门禁）由那边的单测锁住。
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    const action = resolveChoiceKey(choices, cursor, key, escapeValue !== undefined);
    switch (action.kind) {
      case "move":
        setCursor(action.index);
        return true;
      case "select": {
        const choice = choices[action.index];
        if (choice) {
          setCursor(action.index);
          onSelect(choice.value);
        }
        return true;
      }
      case "escape":
        onSelect(escapeValue as T);
        return true;
      case "ignore":
        return false;
    }
  });

  return (
    <Box flexDirection="column">
      {choices.map((choice, i) => {
        const focused = i === cursor;
        const accent = toneColor(choice.tone);
        return (
          <Box key={choice.hotkey} flexDirection="column">
            <Box>
              {/* 指针列：焦点态的第一通道（字形） */}
              <Box width={2} flexShrink={0}>
                <Text color={focused ? accent : theme.text.secondary}>
                  {focused ? POINTER : " "}
                </Text>
              </Box>
              {/* radio 列：填充度表达当前落点，与 ask_user_question 单选题同一套字形 */}
              <Box width={2} flexShrink={0}>
                <Text color={focused ? accent : theme.text.secondary}>
                  {focused ? RADIO_SELECTED : RADIO_EMPTY}
                </Text>
              </Box>
              {/* 快捷键徽标：始终按语义色高亮，让「能敲字母」这件事保持可见 */}
              <Box flexShrink={0}>
                <Text color={accent} bold>
                  {choice.hotkey}
                </Text>
                <Text color={theme.text.secondary}>{"  "}</Text>
              </Box>
              <Text color={focused ? accent : theme.text.primary} bold={focused}>
                {choice.label}
              </Text>
            </Box>
            {/* 说明只在焦点行展示：避免四行说明把框撑成一堵墙（L2.2 留白优先） */}
            {focused && choice.description && (
              <Box paddingLeft={6}>
                <Text color={theme.text.secondary}>{choice.description}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
