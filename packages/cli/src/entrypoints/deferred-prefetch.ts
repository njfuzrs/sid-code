/**
 * 延迟预取机制
 * 首屏渲染后调用——所有操作都是 fire-and-forget，不阻塞用户交互
 *
 * 预取走的是真实缓存路径：
 *   - Git 状态 → generateGitStatusAttachment() → 模块级缓存
 *   - 记忆摘要 → MemoryStore.generateSummary() → 模块级缓存
 * 后续 buildSystemPrompt 调用时直接命中缓存，零延迟
 */

import { profileCheckpoint } from "@sid-code/shared/utils/startup-profiler.ts";
import { preconnectApi } from "./preconnect.ts";

/**
 * 启动延迟预取
 * 非交互模式（--print）没有「用户正在输入」的时间窗口，预取是纯开销，跳过
 */
export function startDeferredPrefetches(isInteractive: boolean): void {
  if (!isInteractive) return;

  profileCheckpoint("deferred_prefetch_start");

  // API 预连接：在用户输入期间提前建立 TCP+TLS，首次请求零握手延迟。
  // 走环境变量配置的 base URL（已在 init 阶段经 safe-env 处理），无则用官方端点。
  preconnectApi(process.env.SID_CODE_LLM_BASE_URL);

  void prefetchGitStatus();
  void prefetchMemory();
}

async function prefetchGitStatus(): Promise<void> {
  try {
    // 走真实的附件生成路径，结果写入模块级缓存
    const { generateGitStatusAttachment } = await import("@sid-code/core/config/attachments.ts");
    generateGitStatusAttachment(process.cwd());
  } catch {
    // 静默失败——预取失败不影响正常流程
  }
}

async function prefetchMemory(): Promise<void> {
  try {
    // 走真实的 MemoryStore 路径，结果写入模块级缓存
    const { MemoryStore } = await import("@sid-code/core/memory/store.ts");
    const memStore = new MemoryStore(process.cwd());
    await memStore.generateSummary();
  } catch {
    // 静默失败
  }
}
