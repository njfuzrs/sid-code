/**
 * Dynamic Workflows M4 — 每代理工作目录上下文(AsyncLocalStorage)
 *
 * 问题:worktree 真并行要求 N 个子代理各自有独立 cwd,但 `process.chdir()` 是进程级全局态
 * (swarm/team.ts 正因此只能让隔离成员串行)。
 *
 * 方案:用 AsyncLocalStorage 给"当前异步执行链"绑定一个 cwd。子代理在 `withAgentCwd(dir, fn)`
 * 里跑,期间所有 `getCwd()`(经 bootstrap/state.ts)优先读 ALS store,于是文件类工具
 * (read/write/edit/ls/glob/bash via normalizeToolPath)自动以该 worktree 为基准——
 * **无需 chdir,无需改每个工具的签名,并发安全**(实测跨 await 不串台)。
 *
 * 未进入 withAgentCwd 时 store 为空,getCwd() 回退到全局 state.cwd,行为与改造前完全一致。
 *
 * ⚠️ 低依赖:本模块不 import 业务模块,供 bootstrap/state.ts 安全引用。
 */

import { AsyncLocalStorage } from "node:async_hooks";

const cwdStorage = new AsyncLocalStorage<string>();

/** 在绑定到 `dir` 的异步上下文里运行 fn。期间 getAgentCwd() 返回 dir。 */
export function withAgentCwd<T>(dir: string, fn: () => T): T {
  return cwdStorage.run(dir, fn);
}

/** 取当前异步上下文绑定的 cwd;不在任何 withAgentCwd 内时返回 undefined。 */
export function getAgentCwd(): string | undefined {
  return cwdStorage.getStore();
}
