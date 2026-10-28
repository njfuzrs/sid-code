/**
 * CLAUDE.md `## Disallowed Tools` 落地到工具集裁剪端。
 *
 * ## 为什么要单独一处
 *
 * `disallowedTools` 有两个来源：命令行 / settings，以及 CLAUDE.md。前者在 `cli.ts` 启动期
 * 调 `toolRegistry.removeByNames` 裁掉，后者在 `app.ts` `applyProjectRules` 合并，而那里
 * 原先**只追加进 config**，没有裁剪。后果有两条（2026-10-27 读码核出）：
 *
 * 1. 被禁工具的 schema 仍进上下文，模型照样会调、每次换回一条拒绝——正是 `cli.ts`
 *    那段注释明确否掉的「一轮一轮地烧」形态；
 * 2. 叠加 `--dangerously-skip-permissions` 时权限层在 Step 3 之前早退，这份名单**什么都不拦**，
 *    且不打日志。与 2026-08-26 评测容器 `disallowedTools` 静默空操作是同一个形态。
 *
 * `applyProjectRules` 的三个调用点（启动 doInit、CLAUDE.md 热重载、切 worktree）都晚于
 * `cli.ts` 的裁剪，所以启动时就写在 CLAUDE.md 里的禁用也受影响，不只是会话中途。
 *
 * ## 语义：会话内只收紧、不放宽
 *
 * `removeByNames` 会把名字记进 registry 的拒收名单，之后无法再注册回来。所以从 CLAUDE.md
 * 删掉一条禁用，会话内不会解除，需要重启——与远程策略「只允许收紧」同一取向。
 * config 名单因此也按并集去重维护：热重载重复合并同一份名单不再无限追加重复项。
 *
 * 代价（点破）：会话中途新增禁用会改变工具列表，击穿一次前缀缓存（工具 → system → 消息）。
 * 这条路径本来就低频，换「被禁工具真的不可用」值得。
 */

/** 只依赖 registry 的这一个方法，便于测试注入。 */
export interface ToolDenylistRegistry {
  removeByNames(names: string[]): string[];
}

export interface ToolDenylistResult {
  /** 合并去重后的完整禁用名单（应写回 config.disallowedTools）。 */
  merged: string[];
  /** 本次实际从 registry 移除的工具名（真实名）。 */
  removed: string[];
}

/**
 * 把 CLAUDE.md 的禁用名单并入现有名单，并对 registry 做裁剪。
 *
 * 对整份 `ruleNames` 调 `removeByNames`（而非只对「新增」部分）：它是幂等的，
 * 且能覆盖「名字早已在 config 名单里、但工具是之后才注册进来」的情形。
 */
export function applyRuleToolDenylist(
  registry: ToolDenylistRegistry,
  current: readonly string[],
  ruleNames: readonly string[],
): ToolDenylistResult {
  const merged = [...current];
  for (const n of ruleNames) {
    if (!merged.includes(n)) merged.push(n);
  }
  const removed = ruleNames.length > 0 ? registry.removeByNames([...ruleNames]) : [];
  return { merged, removed };
}
