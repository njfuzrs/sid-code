/**
 * MEMORY.md 索引的截断预算（P1-7 的单一事实源）
 *
 * ─── 为什么这段逻辑必须只有一份 ───
 *
 * 修 P1-7 时发现同样的三个口径错在仓库里有**两份实现**：
 * `store.ts` 的 `writeIndex`（global/project 记忆线）与 `agent-store.ts` 的
 * `rebuildAgentIndex`（agent 记忆线）。两处逐字符雷同，三个 bug 一模一样 ——
 * 只修前者会留下一份「已知坏的副本」，而它服务的是子代理跨会话记忆，
 * 更少有人看，坏得更久。所以这里把「怎么截断」收成一处，两条线都调它。
 *
 * 三个口径分别修的是什么（细节与实测数字见 `types.ts` 的两个常量注释）：
 *
 * ① **数指针条数，不数总行数**。`# Memory Index` + 空行那两行表头此前挤占配额，
 *    200 只放得下 198 条 —— 于是稳态下永远有 2 条记忆在磁盘上、不在索引里，
 *    表现成「孤儿」，与 P0-1 的重名遮蔽症状同形、成因不同，排查时互相冒充。
 *
 * ② **量真 UTF-8 字节**。旧代码拿 `content.length`（UTF-16 code unit 数）比
 *    名叫 `INDEX_MAX_BYTES` 的常量。中文 1 字符 = 3 字节 ⇒ 实测 190 条纯中文摘要
 *    `char 25041 / utf8 67725`，**超标 2.7 倍**。索引每个会话全量常驻 system prompt，
 *    量错单位不是"差一点"，是每一轮都在付的隐形固定成本。
 *
 * ③ **只在行边界停，且预算里预留警告文案**。旧代码 `slice(0, MAX)` 硬切，末行残缺成
 *    `- [某键](某文件.m` —— 它**看起来像一条完整可用的索引项**，模型据此 Read 必然失败，
 *    比缺一行更糟；按 code unit 切还可能切开代理对（本仓库索引含 ⭐⚠️🌐⚡）。
 *    而且旧代码先切到上限、再 `+=` 警告文案，**最终长度必然超过上限**，上限自己失守。
 */

import { MEMORY_LIMITS } from "./types.ts";

/** 索引表头（两行）。不占条目配额 —— 这正是 ① 修的东西。 */
const INDEX_HEADER = ["# Memory Index", ""] as const;

/**
 * 索引截断警告文案。
 *
 * 抽成常量是为了能**先量它的字节、再从预算里扣掉**（③）。
 * 文案里的数字跟着 `MEMORY_LIMITS` 走，不写死 —— 改常量时文案自动跟上。
 */
export const INDEX_TRUNCATION_NOTICE =
  `\n> ⚠️ 索引已截断（超过 ${MEMORY_LIMITS.INDEX_MAX_ENTRIES} 条 / ` +
  `${Math.round(MEMORY_LIMITS.INDEX_MAX_BYTES / 1000)}KB 上限），部分记忆未列出。\n`;

/**
 * 量真 UTF-8 字节数（②）。
 *
 * 导出是给门禁测试用的：`.length` 与本函数在纯 ASCII 上恰好相等，
 * 所以断言必须用**含中文**的样本，否则测试会在两种实现下同时变绿。
 */
export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * 按「≤N 条指针 + ≤M 真字节」把索引条目行拼成最终文件内容。
 *
 * @param entryLines 已排序好的条目行（不含换行，形如 `- [key](file.md) — desc`）。
 *   排序由调用方负责（两条线的排序键不同：store 用 `updatedAt`、agent 用 mtime）。
 * @returns `content` 可直接落盘（含表头与结尾换行，超限时已附警告）；
 *   `entryCount` 实际列出的条数；`truncated` 是否发生截断。
 *
 * 不变量（门禁在 `tests/memory/index-budget-p1.test.ts` 逐条断言）：
 * - `utf8Bytes(content) <= INDEX_MAX_BYTES`，**含**警告文案在内；
 * - `entryCount <= INDEX_MAX_ENTRIES`，且表头不占配额；
 * - 输出里每个条目行都是完整的 —— 不存在半行链接。
 */
export function buildTruncatedIndex(entryLines: readonly string[]): {
  content: string;
  entryCount: number;
  truncated: boolean;
} {
  const warnBytes = utf8Bytes(INDEX_TRUNCATION_NOTICE);
  const budget = MEMORY_LIMITS.INDEX_MAX_BYTES;

  const lines: string[] = [...INDEX_HEADER];
  // 表头 + 结尾换行先记账：预算约束的是**最终文件**，不是条目行的总和
  let used = utf8Bytes(INDEX_HEADER.join("\n") + "\n");
  let truncated = false;

  for (const line of entryLines) {
    // ① 条数按条目算，表头不挤占
    if (lines.length - INDEX_HEADER.length >= MEMORY_LIMITS.INDEX_MAX_ENTRIES) {
      truncated = true;
      break;
    }
    // ②+③ 真字节，且放不下整行就停手 —— 绝不切一行的中间
    const lineBytes = utf8Bytes(line + "\n");
    if (used + lineBytes > budget - warnBytes) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += lineBytes;
  }

  let content = lines.join("\n") + "\n";
  if (truncated) content += INDEX_TRUNCATION_NOTICE;
  return { content, entryCount: lines.length - INDEX_HEADER.length, truncated };
}
