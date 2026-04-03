/**
 * 延迟预取机制
 * 首屏渲染后调用——所有操作都是 fire-and-forget，不阻塞用户交互
 *
 * 时间线：
 *   REPL 首屏渲染完成
 *     ├─ startDeferredPrefetches()
 *     │   ├─ prefetchGitStatus()     ──→ [后台执行...] → 缓存就绪
 *     │   ├─ prefetchMemory()        ──→ [后台执行...] → 缓存就绪
 *     │   └─ warmSystemPrompt()      ──→ [后台执行...] → 缓存就绪
 *     │
 *     │   用户正在输入问题...（预取在后台完成）
 *     │
 *     └─ 用户按下 Enter → 构建 API 请求 → 命中缓存，零延迟
 */

import { profileCheckpoint } from "../utils/startup-profiler.ts";

/**
 * 启动延迟预取
 * 非交互模式（--print）没有「用户正在输入」的时间窗口，预取是纯开销，跳过
 */
export function startDeferredPrefetches(isInteractive: boolean): void {
  if (!isInteractive) return;

  profileCheckpoint("deferred_prefetch_start");

  void prefetchGitStatus();
  void prefetchMemory();
  void warmSystemPrompt();
}

async function prefetchGitStatus(): Promise<void> {
  try {
    // 预取 git 状态信息，结果会被系统提示词构建模块缓存
    const { execSync } = await import("child_process");
    execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", {
      encoding: "utf-8",
      timeout: 3000,
    });
  } catch {
    // 静默失败——预取失败不影响正常流程
  }
}

async function prefetchMemory(): Promise<void> {
  try {
    const { MemoryStore } = await import("../memory/store.ts");
    const memStore = new MemoryStore(process.cwd());
    await memStore.generateSummary();
  } catch {
    // 静默失败
  }
}

async function warmSystemPrompt(): Promise<void> {
  try {
    // 预构建系统提示词的部分组件（如 git 状态），填充缓存
    const { execSync } = await import("child_process");
    execSync("git status --porcelain 2>/dev/null", {
      encoding: "utf-8",
      timeout: 3000,
    });
  } catch {
    // 静默失败
  }
}
