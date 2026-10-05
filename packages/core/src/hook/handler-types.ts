/**
 * Hook handler 类型的唯一事实源（H24）。
 *
 * 曾经有三处各写一份枚举：settings 的 Zod schema 只认 command/url，
 * `config/schema.ts` 与 registry 认 prompt/agent —— 于是照官网写一个 prompt 型 hook，
 * Zod 判它非法。三处现在都从这里派生，`tests/hook/handler-types-single-source.test.ts`
 * 互相断言，新增类型只改这一处。
 *
 * 本文件刻意零 import：`config/` 层要引它，不能顺带把 hook 子系统拖进配置加载链。
 */

/** 用户可写进 settings.json / 插件 / skill 的 handler 类型 */
export const USER_HOOK_HANDLER_TYPES = ["command", "url", "prompt", "agent"] as const;

/** 运行期全部合法类型：用户类型 + 只能由内部代码注册的 runtime */
export const ALL_HOOK_HANDLER_TYPES = [...USER_HOOK_HANDLER_TYPES, "runtime"] as const;

export type UserHookHandlerType = (typeof USER_HOOK_HANDLER_TYPES)[number];

export function isUserHookHandlerType(t: unknown): t is UserHookHandlerType {
  return typeof t === "string" && (USER_HOOK_HANDLER_TYPES as readonly string[]).includes(t);
}
