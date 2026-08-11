/**
 * statusLine 配置的**类型契约**（P2-2 分包：core 侧）
 *
 * 为什么类型在 core、实现在 cli：`Config.statusLine`（`config/config.ts`）与命令契约
 * （`CommandContext.setStatusLine/getStatusLine`）都需要这个类型，而它们都属 core；
 * 但真正**跑用户脚本**的实现（spawn + 超时 + 节流）是 TUI 关注点，留在
 * `ui/statusline/run-statusline.ts`（cli）。
 *
 * 类型下移让 `core → cli` 的越界消失，同时不把 spawn 逻辑拖进 core。
 * 见方案 §4.2 修法②。
 */

/** statusLine 配置（来自 settings.statusLine）。 */
export interface StatusLineConfig {
  type?: "command";
  command?: string;
  padding?: number;
}
