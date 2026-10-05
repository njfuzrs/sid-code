/** next 实现：宿主组件。Box / Text 来自上游 ink（T4.1 补齐 props），Ansi / RawAnsi 新写（T4.1），其余待实现。 */
import { notImplementedComponent } from "./not-implemented.ts";

export { Ansi, Box, RawAnsi, Text } from "@sid-code/tui";
// 不 re-export 上游 <Static>：它是 print-once 语义，与端口的 Static 不同（D-3 定案 A，T4.2 新写）
export const Static = notImplementedComponent("Static", "T4.2");
export const AlternateScreen = notImplementedComponent("AlternateScreen", "T6.1");
