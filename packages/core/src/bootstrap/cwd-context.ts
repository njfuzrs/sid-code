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
 * W16:store 是**可写的盒子**而不是裸字符串。bash 的 `cd` 追踪要能改「这个子代理自己的」
 * cwd;裸字符串的 store 只能读不能写,于是 setCwd 只能去改全局 state.cwd ——
 * 结果是子代理自己的 cd 不生效、主会话的目录反被改掉(实测)。读和写必须落在同一个位置。
 * `root` 记下进入时绑定的目录(隔离边界),`cd` 只改 `cwd`,不改 `root`。
 *
 * ⚠️ 低依赖:本模块不 import 业务模块,供 bootstrap/state.ts 安全引用。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { sep } from "node:path";

/** 隔离 worktree 的固定落点：`<主仓>/.sid-code/worktrees/<name>`（见 worktree/manager.ts）。 */
const ISOLATED_WORKTREE_MARKER = `${sep}.sid-code${sep}worktrees${sep}`;

/**
 * 把一个路径拆成「所属隔离 worktree 根 + 它的主仓根」；不在隔离 worktree 内返回 null。
 *
 * 曾经有三处各写一份 marker 判定（权限 W12、子代理提示词 D13、bash），口径一漂就是
 * 「提示词说在隔离区、权限按主仓判」这类自相矛盾。统一到这里。
 */
export function splitIsolatedWorktreePath(
  p: string,
): { worktreeRoot: string; mainRepo: string } | null {
  const idx = p.indexOf(ISOLATED_WORKTREE_MARKER);
  if (idx < 0) return null;
  const nameStart = idx + ISOLATED_WORKTREE_MARKER.length;
  const nameEnd = p.indexOf(sep, nameStart);
  const worktreeRoot = nameEnd < 0 ? p : p.slice(0, nameEnd);
  if (worktreeRoot.length === nameStart) return null; // `.../worktrees/` 本身不是某个 worktree
  return { worktreeRoot, mainRepo: p.slice(0, idx) };
}

interface AgentCwdBox {
  /** 进入 withAgentCwd 时绑定的目录（隔离边界，W12 用它判「写没写出自己的 worktree」） */
  readonly root: string;
  /** 当前 cwd（bash `cd` 会改它） */
  cwd: string;
}

const cwdStorage = new AsyncLocalStorage<AgentCwdBox>();

/** 在绑定到 `dir` 的异步上下文里运行 fn。期间 getAgentCwd() 返回 dir。 */
export function withAgentCwd<T>(dir: string, fn: () => T): T {
  return cwdStorage.run({ root: dir, cwd: dir }, fn);
}

/** 取当前异步上下文绑定的 cwd;不在任何 withAgentCwd 内时返回 undefined。 */
export function getAgentCwd(): string | undefined {
  return cwdStorage.getStore()?.cwd;
}

/** 取当前异步上下文进入时绑定的根目录(不随 cd 变化);不在上下文内返回 undefined。 */
export function getAgentRoot(): string | undefined {
  return cwdStorage.getStore()?.root;
}

/**
 * 当前异步上下文是否绑定在某个隔离 worktree 上；是则返回其根与主仓根。
 * 判据取进入时的 root（不随 cd 变），cd 出去不等于离开了隔离边界。
 */
export function getIsolatedWorktree(): { worktreeRoot: string; mainRepo: string } | null {
  const root = getAgentRoot();
  return root ? splitIsolatedWorktreePath(root) : null;
}

/**
 * 在代理上下文内改写本上下文的 cwd。返回 true 表示已写入(调用方不要再碰全局 state.cwd);
 * 不在任何 withAgentCwd 内时返回 false。
 */
export function setAgentCwd(dir: string): boolean {
  const box = cwdStorage.getStore();
  if (!box) return false;
  box.cwd = dir;
  return true;
}
