/**
 * 经 write / edit 工具写记忆目录时的闸门与善后（P1-8 + P1-11）
 *
 * ─── P1-8：secret 防线此前只覆盖三条记忆线中的一条 ───
 *
 * | 写入路径 | 修复前的闸门 |
 * | --- | --- |
 * | `save_memory` 工具（任意 scope） | ✅ `detect()` 命中即拒（tool/memory.ts） |
 * | team scope（`saveTeamMemory`） | ✅ `scanForSecrets` |
 * | team 目录（经 write/edit） | ✅ `checkTeamMemSecrets` |
 * | team push 到共享目录 | ✅ 逐条扫，命中跳过 |
 * | **私有记忆目录（经 write/edit）** | ❌ **无** |
 * | **agent 记忆目录（`saveAgentMemory`）** | ❌ **无** |
 *
 * 三条理由说明后两行是缺口，而不是「私有记忆不需要防」：
 *
 * 1. **后台提取代理有 write/edit 权限，且被授权写整个记忆目录**
 *    （`extract/permissions.ts` 的 `WRITE_TOOLS`）。它是个**无人监督的 LLM**，
 *    从对话里抽取内容落盘 —— 对话里若出现过凭证（用户粘的 token、报错栈里的连接串），
 *    走 write 路径写入时此前没有任何闸门。**同一个代理、两条权限相同的路径、
 *    防护不对称**：`save_memory` 有闸门，write 没有。
 * 2. **私有记忆并非不外泄**：`~/.sid-code/projects/<key>/memory/` 与 `team-memory/`
 *    **同级同父目录**，备份、同步盘、共享场景下一并带走。
 * 3. **`redactInfraCoordinates` 的存在本身就证明私有记忆需要脱敏** ——
 *    store.ts 那段注释记录了一次真实事故（生产服务器公网 IP + root 写进 description，
 *    随索引常驻每个会话的 system prompt）。那次的修法是**索引摘要脱敏**，
 *    正文里的凭证仍原样留在磁盘上（注释明说「模型需要时 Read 那个文件仍拿得到」）。
 *    这个取舍对 IP 合理（易误报），但它不覆盖「真凭证经 write 写入私有记忆正文」。
 *
 * ⚠️ **为什么用 `SecretRedactHook.detect` 而不是 team 那套 `scanForSecrets`**：
 * 两者规则集不同 —— gitleaks 子集只收「独特前缀、近零误报」的规则，
 * `detect` 额外覆盖 generic api_key / bearer / db 连接串。私有记忆这条路上
 * 最可能出现的恰是后者（报错栈里的连接串），且它与 `save_memory` 的闸门**同一个实现** ——
 * 这是刻意的：同一个代理的两条路径必须同判据，否则模型换条路就能绕过。
 *
 * ─── P1-11：外部写入必须推进缓存代数 ───
 *
 * `MemoryStore` 生产有 9 个实例、各自持一份内存快照。经 write/edit 改记忆文件
 * **不经过 `store.set()`**，所以旧代码里这类写入完全不会让任何实例失效：
 * 提取代理写完，本会话注入侧看到的还是旧索引。这里在写入成功后推进代数补上。
 */

import { getSharedSecretRedactHook } from "../llm/hooks/secret-redact.ts";
import { isAnyPrivateMemPath } from "./paths.ts";
import { getLogger } from "../debug/logger.ts";
import { invalidateMemoryCaches } from "./store.ts";
// P1-12 指标 ③：防线触发计数（恒 0 的曲线本身是信号）。
import { logMemoryGuard } from "../analytics/events.ts";

/**
 * 私有 / agent 记忆写入的 secret 闸门（P1-8）。
 *
 * @returns 命中 secret 时返回错误信息（调用方据此**拒绝写入**）；安全或非记忆路径返回 null。
 *
 * ⚠️ 与 `checkTeamMemSecrets` 不同，本闸门**没有 enabled 开关**：私有记忆一直在写，
 * 没有「未启用」这个状态。给它加开关等于给唯一的闸门加一个默认关闭的旁路。
 */
export function checkPrivateMemSecrets(
  filePath: string,
  content: string,
  cwd: string = process.cwd(),
): string | null {
  if (!isAnyPrivateMemPath(filePath, cwd)) return null;

  const hits = getSharedSecretRedactHook().detect(content);
  if (hits.length === 0) return null;

  const categories = Array.from(new Set(hits.map((h) => h.category))).join(", ");
  getLogger().warn("TOOL", `✗ 拒绝写入含 secret 的记忆文件 (${categories}): ${filePath}`);
  // P1-12 指标 ③：防线触发计数。恒 0 本身就是信号 ——
  // P1-8 这条缺口之所以长期无人知情，正因为「防线不存在」与「防线从未触发」
  // 在轨迹里长得一模一样。不记路径、不记命中内容，只记类型与来源。
  logMemoryGuard({ kind: "secret_rejected", via: "write_edit" });
  return (
    `内容包含潜在 secret (${categories})，拒绝写入记忆目录。\n` +
    `记忆会随 MEMORY.md 索引常驻每个会话的系统提示词，凭证一旦写进去会被反复发往模型。\n` +
    `凭证应放在 .env / 环境变量，运行时经 process.env 读取；` +
    `只需描述类型时写「用户用 GitHub PAT 调 API」这种元信息，不要写明文。`
  );
}

/**
 * 一次「经 write/edit 写记忆文件」成功之后的善后（P1-11）。
 *
 * 幂等、无返回值、不抛：调用方在写入成功后无条件调一次即可，
 * 非记忆路径自动 no-op（判据与闸门同源，两者不会对「这是不是记忆写入」有分歧）。
 */
export function afterMemoryFileWrite(filePath: string, cwd: string = process.cwd()): void {
  if (!isAnyPrivateMemPath(filePath, cwd)) return;
  invalidateMemoryCaches();
}
