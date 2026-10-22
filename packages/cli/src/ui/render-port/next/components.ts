/** next 实现：宿主组件。Box / Text 来自上游 ink（T4.1 补齐 props），Ansi / RawAnsi（T4.1）、History（T4.2）、AlternateScreen（T6.1a）新写。 */
export { AlternateScreen, Ansi, Box, RawAnsi, Text } from "@sid-code/tui";
// 端口名仍叫 Static（CLI 调用点不动），底座里是新写的 History，不是上游 print-once 的 <Static>（D-3 定案 A）
export { History as Static } from "@sid-code/tui";
// 临时浮层容器：对话框 / 补全菜单包在里面，主屏关闭后整帧重画复原被顶进 scrollback 的历史
export { Transient } from "@sid-code/tui";
