/**
 * `find` 的副作用动作 —— 会真的删 / 写文件，或执行任意命令。
 *
 * ## 为什么单独一个文件
 *
 * 这份数据此前在仓里被抄了**三遍**（字面量完全相同，只有书写顺序不同）：
 * - `tool/bash/read-only-validation.ts` 的只读判定（`isReadOnlyFind`）
 * - `memory/extract/permissions.ts` 的后台代理白名单（`isReadonlyBash`）
 * - `permission/shell-command-variants.ts` 的写目标保护（`findWriteTargets`）
 *
 * 同一份数据抄三遍的后果是「改一处漏一处就一边拦一边放」，而且不会有任何东西变红。
 * 合并的是**纯数据**，不改变任何一方的行为。
 *
 * 放在独立文件而不是 `read-only-validation.ts` 里，是因为
 * `permission/shell-command-variants.ts` 被 `read-only-validation.ts` 反向 import
 * （`expandShellCommand`），让它再去 import 那份实现会成环。本文件零依赖。
 *
 * ## 判据
 *
 * 只看 token **精确相等**——`-name '-delete'` 这种把它当模式值的写法会被误判成有副作用，
 * 方向是落到确认，可接受。反过来做前缀匹配会漏掉 `-exec` 之外的组合形态，不可接受。
 */
export const FIND_SIDE_EFFECT_ACTIONS: ReadonlySet<string> = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);
