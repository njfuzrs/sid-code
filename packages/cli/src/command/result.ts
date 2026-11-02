/**
 * 命令结果构造的小工具。
 *
 * 旧体系 `CommandResult` 有独立的 `kind: "error"`，经 adapter 的 `convertResult` 映射成
 * `{ type: "text", value: "错误: …" }`。命令体系收口（旧体系删除）后，原先返回 error 的命令
 * 改用这个函数，保持用户看到的文本与迁移前逐字一致（含「错误: 」前缀）。
 */

import type { LocalCommandResult } from "./types.ts";

export function errorText(message: string | undefined): LocalCommandResult {
  return { type: "text", value: `错误: ${message ?? ""}` };
}
