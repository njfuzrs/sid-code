/**
 * 输出语言快捷切换面板（/language 无参时打开）
 *
 * 选项固定（zh/en/auto/unset），结构同 ThinkDialog / EffortDialog。
 * - 当前生效项用 ● 标记（区别于光标指示的 ›）
 * - 四档字形靠「填充度」表达确定性递进（L1 元原则①）：
 *   zh/en 是显式指定（实心 ●）、auto 是运行时判定（半填 ◐）、unset 是无偏好（空心 ○）
 *
 * 「当前值」的判定必须区分 `auto` 与 `undefined`——前者是**有偏好**（跟随用户输入语言），
 * 后者是**无偏好**（回落缺省中文优先）。旧版 /language 文本输出曾把未设置回显成 auto，
 * 让用户以为已在自动模式，实际行为却是强制中文；面板不能重犯这个错，故 unset 独立成一档。
 */

import React from "react";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import { theme } from "../semantic-colors.ts";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import {
  ARROW_PROMPT,
  TODO_COMPLETED,
  TODO_IN_PROGRESS,
  TODO_PENDING,
} from "../constants/figures.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import {
  describeLanguagePref,
  detectSystemLanguage,
  type LanguagePref,
} from "@sid-code/core/config/prompt-lang.ts";

/** 面板选项 value：真实偏好值 + "unset" 哨兵（代表 undefined，即清除偏好）。 */
export type LanguageChoice = LanguagePref | "unset";

interface LanguageDialogProps {
  onClose: () => void;
  /** 当前语言偏好（undefined = 未设置，回落缺省中文优先）。 */
  currentLanguage: LanguagePref | undefined;
  /** 选定回调。"unset" 表示清除偏好；关闭由外部回调统一处理（同 onThemeSelect）。 */
  onLanguageSelect: (choice: LanguageChoice) => void;
}

interface LanguageItem extends SelectionListItem<LanguageChoice> {
  glyph: string;
  label: string;
  desc: string;
}

const OPTIONS: LanguageItem[] = [
  { value: "zh", key: "zh", glyph: TODO_COMPLETED, label: "zh", desc: "中文优先" },
  { value: "en", key: "en", glyph: TODO_COMPLETED, label: "en", desc: "英文优先" },
  {
    value: "auto",
    key: "auto",
    glyph: TODO_IN_PROGRESS,
    label: "auto",
    desc: "跟随用户输入语言（每轮按用户所用语言应答）",
  },
  {
    value: "unset",
    key: "unset",
    glyph: TODO_PENDING,
    label: "unset",
    desc: "清除偏好，回落缺省（中文优先）",
  },
];

export const LanguageDialog: React.FC<LanguageDialogProps> = ({
  onClose,
  currentLanguage,
  onLanguageSelect,
}) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onClose();
      return true;
    }
    return false;
  });

  // undefined（未设置）映射到 unset 档，而不是 auto——两者语义不同，见文件头注释。
  const currentValue: LanguageChoice = currentLanguage ?? "unset";
  const initialIndex = Math.max(0, OPTIONS.findIndex((o) => o.value === currentValue));

  const statusLine = currentLanguage
    ? `当前: ${currentLanguage} — ${describeLanguagePref(currentLanguage)}`
    : "当前: 未设置 — 默认（中文优先）";

  // auto 档额外说明"判断不出时落到哪"——否则用户切了 auto 却无从判断系统 locale 探测结果。
  const autoFallback = currentLanguage === "auto"
    ? `判断不出用户语言时回落: ${detectSystemLanguage() === "en" ? "英文" : "中文"}（按系统 locale）`
    : "";

  const handleSelect = (choice: LanguageChoice) => {
    onLanguageSelect(choice);
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
      <Text bold color={theme.ui.active}>输出语言</Text>
      <Text color={theme.text.secondary}>{statusLine}</Text>
      {autoFallback && <Text color={theme.text.secondary}>{autoFallback}</Text>}
      <Box marginTop={1} flexDirection="column">
        <BaseSelectionList<LanguageChoice, LanguageItem>
          items={OPTIONS}
          initialIndex={initialIndex}
          onSelect={handleSelect}
          isFocused={true}
          showNumbers={false}
          maxItemsToShow={6}
          selectedIndicator={ARROW_PROMPT}
          renderItem={(item, { isSelected }) => {
            const isCurrent = item.value === currentValue;
            return (
              <Box>
                <Text color={isSelected ? theme.ui.focus : theme.text.primary}>
                  {item.glyph} {item.label}
                </Text>
                <Text color={theme.text.secondary}>  {item.desc}</Text>
                {isCurrent && <Text color={theme.ui.active}> {TODO_COMPLETED} 当前</Text>}
              </Box>
            );
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text italic>↑↓ 导航 · Enter 切换（自动持久化）· Esc 取消</Text>
      </Box>
    </Box>
  );
};
