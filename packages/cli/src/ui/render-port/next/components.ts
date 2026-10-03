/** next 实现：宿主组件。Box / Text 直接用上游 ink，其余待实现。 */
import { notImplementedComponent } from "./not-implemented.ts";

export { Box, Text } from "@sid-code/tui";
// 不 re-export 上游 <Static>：它是 print-once 语义，与端口的 Static 不同（D-3 定案 A，T4.2 新写）
export const Static = notImplementedComponent("Static", "T4.2");
export const Ansi = notImplementedComponent("Ansi", "T4.1");
export const RawAnsi = notImplementedComponent("RawAnsi", "T4.1");
export const AlternateScreen = notImplementedComponent("AlternateScreen", "T6.1");
