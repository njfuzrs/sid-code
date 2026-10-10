/** 端口类型（T0.2：直接取 legacy 的类型；T1.3 起改为端口自有类型 + satisfies 检查）。 */
export type { AnsiColor, Color } from "@sid-code/tui-renderer/styles.ts";
export type { DOMElement } from "@sid-code/tui-renderer/dom.ts";
export type { Props as TextProps } from "@sid-code/tui-renderer/components/Text.tsx";
export type { StyledChar } from "@sid-code/tui-renderer/_vendor/styled-chars.ts";
export type { TabStatusKind } from "@sid-code/tui-renderer/hooks/use-tab-status.ts";
