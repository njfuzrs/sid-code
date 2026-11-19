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

/**
 * 索引保留优先级（S9）：越小越先列、越不容易被字节预算截掉。
 *
 * 放在这里而不是 store.ts：除了 `writeIndex` 排序，后台抽取的「现有记忆清单」（T3）
 * 也按它排，让模型先看到会进索引的那部分。两处必须同一个顺序，否则清单前列的
 * 「已在索引里」与实际索引不符。
 */
export const INDEX_TYPE_RANK: Readonly<Record<string, number>> = {
  user: 0,
  feedback: 1,
  project: 2,
  reference: 3,
};
export function indexTypeRank(t: string | undefined): number {
  return t ? (INDEX_TYPE_RANK[t] ?? 4) : 4;
}

/**
 * 索引行**描述**的字符上限（C3-A，2026-11-03）。
 *
 * 与 `store.ts` 的 `MEMORY_DESC_MAX_LEN`(150) **刻意分开**，别合并成一个常量：
 * 那个值写进 frontmatter，是**磁盘数据**，截短即永久丢信息；这里只影响
 * 每个会话全量常驻 system prompt 的**索引行**。
 *
 * 为什么 25KB 预算要配 40 字符：实测（2026-11-03，本机 project 记忆 201 个文件）
 * 索引行平均 389 字节 = key 45 + 文件名 56 + 描述 277 —— 描述占七成，
 * 于是 25KB 只列得下 63 条（判据是字节，200 条的名义上限从没生效过）。
 * 描述截到 40 字符后同一批数据可列 132 条（实测脚本见落地方案 C3 一节）。
 *
 * 代价点破：摘要信息量下降，召回更依赖 key 命名 —— 这是拿「更准」（可见条数）
 * 换「更省」（每行字节）的取舍，也是 C3 选项 A 的成本。
 */
export const INDEX_DESC_MAX_LEN = 40;

/**
 * 按 `INDEX_DESC_MAX_LEN` 截断索引行描述。
 *
 * 三条线（store 私有记忆 / agent 记忆 / team 记忆）**必须共用**：索引的字节预算
 * 只有一份，任何一条线自己留 150 字符都会把别的线挤掉。与 `buildTruncatedIndex`
 * 同一个理由（见文件头「为什么这段逻辑必须只有一份」）。
 *
 * 按 code point 切而不是 `slice`：索引含 ⭐⚠️🌐⚡，`slice` 可能把代理对切成半个字符
 * （与 `buildTruncatedIndex` ③ 避免的事故同源）。
 *
 * 截断时两件事必须同时做（D-18，2026-11-19）：
 * - **补 `…`**：让读者一眼分辨「原文就到这里」与「后面还有」——旧实现切在冒号上时
 *   （`（从横评中提炼）：`）看起来像一句完整的话；
 * - **退到反引号对之外**：索引进 system prompt 后被当 Markdown 解析，半个代码片段
 *   （`` `docs ``）会和同段别的反引号错配，把大段正常文本吞进 inline code。
 *
 * 代价点破：每行多 1 个字符（`…`），当前索引约 101 条 ⇒ 多约 101 字符 ≈ 25 tok，
 * 相对 25KB 字节预算可忽略。换到的是一份不会被误读、也不会误导解析的索引。
 */
export function truncateIndexDesc(desc: string): string {
  if (!desc) return "";
  const chars = Array.from(desc);
  if (chars.length <= INDEX_DESC_MAX_LEN) return desc;
  // 先给 `…` 留一格，长度才可能不超上限
  let cut = INDEX_DESC_MAX_LEN - 1;
  // 用显式循环数反引号，不用 `head.match(/`/g)`：一次遍历同时拿到「个数」与
  // 「最后一个的位置」，正则要跑两趟，且两套遍历对「字符」的理解容易漂移
  // （chars 已按 code point 切开，正则按 UTF-16 单元）。
  let tickCount = 0;
  let lastTick = -1;
  for (let i = 0; i < cut; i++) {
    if (chars[i] === "`") {
      tickCount++;
      lastTick = i;
    }
  }
  // 只对落在**后半段**的反引号退回：退到它之前会把描述砍掉一半以上，
  // 那种情况下宁可留着（半个代码片段的危害小于索引条目失去信息量）。
  if (tickCount % 2 === 1 && lastTick > cut / 2) cut = lastTick;
  return chars.slice(0, cut).join("") + "…";
}

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
export function buildTruncatedIndex(
  entryLines: readonly string[],
  /**
   * 表头（缺陷 9：团队索引用自己的标题 `# 团队共享记忆`）。必须从这里传，
   * 不能在返回后替换首行 —— 替换会让表头字节不进预算，上限再次失守。
   */
  header: readonly string[] = INDEX_HEADER,
): {
  content: string;
  entryCount: number;
  truncated: boolean;
} {
  const warnBytes = utf8Bytes(INDEX_TRUNCATION_NOTICE);
  const budget = MEMORY_LIMITS.INDEX_MAX_BYTES;

  const lines: string[] = [...header];
  // 表头 + 结尾换行先记账：预算约束的是**最终文件**，不是条目行的总和
  let used = utf8Bytes(header.join("\n") + "\n");
  let truncated = false;

  for (const line of entryLines) {
    // ① 条数按条目算，表头不挤占
    if (lines.length - header.length >= MEMORY_LIMITS.INDEX_MAX_ENTRIES) {
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
  return { content, entryCount: lines.length - header.length, truncated };
}
