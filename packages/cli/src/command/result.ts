/**
 * 命令结果构造的小工具。
 *
 * 旧体系 `CommandResult` 有独立的 `kind: "error"`，经 adapter 的 `convertResult` 映射成
 * `{ type: "text", value: "错误: …" }`。命令体系收口（旧体系删除）后，`LocalCommandResult`
 * 一度没有 `error` 分支，业务失败只能伪装成文本——**无头下所有命令失败都退 0**
 * （缺陷 D2：CI 无法用退出码区分成功与失败，只能 parse stdout 文案）。
 *
 * 现在 `LocalCommandResult` 加回了 `error` 分支，本函数负责构造它。两条不变量：
 * 1. **用户看到的文本与收口前逐字一致**（含「错误: 」前缀）：`message` 是完整展示文本，
 *    TUI 与无头两侧都**不再二次加前缀**。
 * 2. 命令侧不必关心退出码：`error` 经 executor 映射为 `CommandExecutionResult.error`，
 *    无头下 `mapExecutionResult` 把它翻成 `fatal_error`，退出码自然非 0。
 */

import type { LocalCommandResult } from "./types.ts";

export function errorText(message: string | undefined): LocalCommandResult {
  return { type: "error", message: `错误: ${message ?? ""}` };
}
