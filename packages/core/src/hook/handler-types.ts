/**
 * Hook handler 类型的唯一事实源（H24）。
 *
 * 曾经有三处各写一份枚举：settings 的 Zod schema 只认 command/url，
 * `config/schema.ts` 与 registry 认 prompt/agent —— 于是照官网写一个 prompt 型 hook，
 * Zod 判它非法。三处现在都从这里派生，`tests/hook/handler-types-single-source.test.ts`
 * 互相断言，新增类型只改这一处。
 *
 * HC5：对齐 CC 后增加两个名字——
 *   - `http`：CC 的叫法，与 sid 的 `url` 是同一种 handler（归一化层把它落成 url）；
 *   - `mcp_tool`：CC 有、sid 本轮**只识别不执行**（归一化层 warn 跳过）。它必须在合法名单里，
 *     否则 Zod 会把一条 CC 原样搬来的 mcp_tool hook 判成非法，连带让同文件的诊断变噪。
 *
 * 本文件刻意零 import：`config/` 层要引它，不能顺带把 hook 子系统拖进配置加载链。
 */

/** 用户可写进 settings.json / 插件 / skill / agent 的 handler 类型 */
export const USER_HOOK_HANDLER_TYPES = [
  "command",
  "http",
  "url",
  "prompt",
  "agent",
  "mcp_tool",
] as const;

/** 运行期全部合法类型：用户类型 + 只能由内部代码注册的 runtime */
export const ALL_HOOK_HANDLER_TYPES = [...USER_HOOK_HANDLER_TYPES, "runtime"] as const;

/** 识别但本轮不执行的类型（归一化层 warn 跳过，不让它让整个文件失效） */
export const UNSUPPORTED_HOOK_HANDLER_TYPES: ReadonlySet<string> = new Set(["mcp_tool"]);

export type UserHookHandlerType = (typeof USER_HOOK_HANDLER_TYPES)[number];

export function isUserHookHandlerType(t: unknown): t is UserHookHandlerType {
  return typeof t === "string" && (USER_HOOK_HANDLER_TYPES as readonly string[]).includes(t);
}
