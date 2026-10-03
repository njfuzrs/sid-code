/** 宿主组件。见 README.md。 */
export { default as Box } from "@sid-code/tui-renderer/components/Box.tsx";
export { default as Text } from "@sid-code/tui-renderer/components/Text.tsx";
// 注意：这不是上游 ink 的 print-once <Static>，里面的项可以原地重渲（设计文档 D-3）
export { Static } from "@sid-code/tui-renderer/_vendor/Static.tsx";
export { Ansi } from "@sid-code/tui-renderer/Ansi.tsx";
export { RawAnsi } from "@sid-code/tui-renderer/components/RawAnsi.tsx";
export { AlternateScreen } from "@sid-code/tui-renderer/components/AlternateScreen.tsx";
