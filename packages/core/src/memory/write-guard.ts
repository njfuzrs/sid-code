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
import { isAnyPrivateMemPath, resolvePrivateMemDir } from "./paths.ts";
import { getLogger } from "../debug/logger.ts";
import { invalidateMemoryCaches } from "./store.ts";
// P1-1（MD3）：索引已满时，同 key 覆盖的「结论级替换」必须留痕。
import { findConclusionReplacement } from "./conclusion-guard.ts";
import { readIndexCapacity } from "./index-capacity.ts";
import { stripFrontmatter } from "./scan.ts";
import { getSidHome } from "../config/paths.ts";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
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

/**
 * P1-1（MD3）：索引已满时，**经 write / edit 覆盖已有记忆文件**的结论级替换必须留痕。
 *
 * ## 为什么必须落在这条路径上
 *
 * `save_memory` 那道闸门（tool/memory.ts）只覆盖一条写入方式。后台提取代理的
 * `WRITE_TOOLS` 里有 `write` / `edit`，且被授权写整个记忆目录 —— 它被 save_memory 拒了
 * 之后换条路照样能改（P0-4 的回告里已经把这条绕过面写明，见 `negation_unreferenced`）。
 * 判据只落在一条路径上的闸门，防的是「模型恰好选了那条路」，不是「模型改不掉」。
 *
 * ## 判据顺序（性能与安全的权衡）
 *
 * 1. 廉价否定：不在配置根下的路径一定不是记忆文件，直接放行 —— 这条闸门挂在
 *    write/edit 的**每次调用**上，不能为普通源码文件付 fork git 的成本（与
 *    `checkPrivateMemSecrets` 同一个前置）。
 * 2. 新建文件没有「旧结论」可替换，放行。
 * 3. 纯字符串判据（`findConclusionReplacement`）先跑：绝大多数普通写入到这里就早退。
 * 4. 只有「看起来是一次结论级替换」时才做昂贵判定：反推记忆目录 + 读索引容量。
 *
 * @returns 拒绝原因（调用方据此拒绝写入）；放行返回 null。
 */
export function checkMemoryConclusionReplace(
  filePath: string,
  nextContent: string,
  cwd: string = process.cwd(),
): string | null {
  const target = resolve(filePath);
  const home = resolve(getSidHome());
  if (target !== home && !target.startsWith(home + sep)) return null;

  // 新建文件不可能是「替换旧结论」；edit 的空文件分支同理（旧正文为空）
  if (!existsSync(target)) return null;

  let oldText: string;
  try {
    oldText = readFileSync(target, "utf8");
  } catch {
    // 读不动旧文件时不能凭空判定「结论被替换了」——放手交给后续写入，失败形态是漏拦而非误拦
    return null;
  }

  const conflict = findConclusionReplacement(
    stripFrontmatter(oldText),
    stripFrontmatter(nextContent),
  );
  if (!conflict) return null;

  // ─── 只有可能命中时才做昂贵判定 ───
  const memDir = resolvePrivateMemDir(target, cwd);
  if (!memDir) return null; // 不是记忆文件：上面那条判据只是在普通文件上碰巧成立的字符串比较
  if (!readIndexCapacity(memDir).truncated) return null; // 索引没满：新建 key 可行，不必收紧同 key 覆盖

  getLogger().warn("TOOL", `✗ 拒绝结论级替换未留痕的记忆写入: ${target}`);
  // P1-12 指标 ③：与 secret 闸门同一套计数口径（恒 0 也是信号）
  logMemoryGuard({ kind: "conclusion_replace", via: "write_edit" });
  return (
    `这次写入把这条记忆的**主题陈述**换掉了，但没有留下「结论级替换」的痕迹。\n` +
    `判据: 索引已满（新 key 大多落不进模型可见的索引），所以同一个 key 的更新必须说清\n` +
    `「这是修正旧结论」还是「补充细节」。旧条目的首行结论是:\n` +
    `  ${conflict.oldConclusion}\n` +
    `这次的新内容里没有它。\n` +
    `改正方式（二选一）:\n` +
    `  1. 正文里显式写 \`推翻：<旧结论为什么不成立>\`\n` +
    `  2. 正文里显式写 \`纠正：<新结论>\`\n` +
    `若你其实只是补充细节、修措辞，请保留旧条目的首行结论原句。\n` +
    `（「更新：」「补充：」不算声明 —— 它们和「追加」是同一个意思。）`
  );
}
