/**
 * IDE ↔ agent 的 wire 协议常量（**唯一事实源**）
 *
 * 为什么单独一个文件、而不是散在各 handler 里写字面量：
 *
 * D2 的成因不是打字错误，是**抽象泄漏**。MCP **标准**通知都带 `notifications/`
 * 前缀（`notifications/message`、`notifications/progress`），所以写 IDE 通知订阅时
 * 顺手补上前缀是极自然的动作 —— 但 IDE 的这两个通知**不是 MCP 标准通知**，
 * 是 IDE 扩展的私有约定，只是借道 MCP 的通知通道。
 *
 * 而 `mcp/client.ts` 的 `onNotification` 直接把 method 字符串当路由 key，
 * 无任何前缀归一化。于是多一个前缀 = 订阅永远匹配不上，且**完全静默**：
 * 不报错、不打日志（路由器找不到 handler 时什么都不做）、JSON-RPC 通知不需要回复
 * （没有"等不到响应"这个信号）、`/ide status` 照样显示已连接（MCP 握手确实成功了）。
 * 唯一症状是"选区永远是空的"。
 *
 * D4 是它的孪生：测试用**同一个错误的字符串**触发通知，于是测试与实现互相自证，
 * 测试对这个 bug 完全免疫，还把 bug 焊死了 —— 只改实现会让 11 处测试变红，
 * 而"改了代码测试就红了"是一个极强的"快回退"信号。
 *
 * ⛔ **所以：实现与测试必须 import 同一个常量，不许任何一侧重新硬编码 wire 字符串。**
 * 这样下次拼错是**编译错误**，而不是静默失配。门禁见
 * `tests/ide/wire-protocol-single-source.test.ts`。
 */

/**
 * IDE → agent 的通知方法名（IDE 扩展私有约定，**不带** `notifications/` 前缀）。
 *
 * 依据：CC 的 VS Code 扩展 `useIdeSelection.ts` 里是
 * `z.literal('selection_changed')`，`useIdeAtMentioned.ts` 里是
 * `NOTIFICATION_METHOD = 'at_mentioned'`。
 */
export const IDE_NOTIFY = {
  /** 编辑器选区变化 */
  selectionChanged: "selection_changed",
  /** 用户在 IDE 里 @ 引用了某个文件/行范围 */
  atMentioned: "at_mentioned",
} as const;

/**
 * agent → IDE 的通知方法名。
 *
 * `ide_connected` 让 IDE 侧知道是哪个 CLI 进程连上来了（带 `{pid}`），
 * IDE 的连接状态指示器靠它点亮 —— 不发就是"IDE 里看不出连上了没"（D5）。
 */
export const AGENT_NOTIFY = {
  ideConnected: "ide_connected",
} as const;

/**
 * IDE 暴露的 MCP 工具名（diff 相关）。
 *
 * 注意 `closeTab` 是**单个**标签页，`closeAllDiffTabs` 是全部 —— 此前只有后者，
 * 于是一轮里开的多个 diff 只能一起关（D3）。
 */
export const IDE_RPC = {
  openDiff: "openDiff",
  closeTab: "close_tab",
  closeAllDiffTabs: "closeAllDiffTabs",
} as const;

/**
 * `openDiff` 的响应状态字面量（CC 扩展在 `[{type:'text', text:<此处>}]` 里回这些）。
 */
export const DIFF_STATUS = {
  saved: "FILE_SAVED",
  rejected: "DIFF_REJECTED",
  tabClosed: "TAB_CLOSED",
} as const;

export type IDENotifyMethod = (typeof IDE_NOTIFY)[keyof typeof IDE_NOTIFY];
export type DiffStatus = (typeof DIFF_STATUS)[keyof typeof DIFF_STATUS];
