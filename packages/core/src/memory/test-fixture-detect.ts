/**
 * 已知测试夹具检测（D-15 第 3 步：自愈门禁的**只读**一半）
 *
 * ─── 为什么需要它 ───
 *
 * `~/.sid-code/memory/reference_doc-example.md` 是 `packages/core/tests/tool/memory.test.ts`
 * 里「含 EXAMPLE 占位的 token-like 字符串不被误判」那条用例的**测试夹具**
 * （key=`doc_example`，实测写盘时间 2026-08-10 前后）。该测试在 2026-08 加入时没有
 * 文件级 `SID_CONFIG_DIR` 隔离，2026-11-15 才补上（`6425bbba`）——中间三个多月每次
 * 跑测试都会往用户**真实**的记忆目录写一条假记忆。隔离只堵住了未来写入，
 * 已经落盘的那条还在，而 `MEMORY.md` 每轮全量注入 ⇒ 每个会话都在给模型读一条
 * 假记忆（值里还带一个 AWS 示例 key）。
 *
 * 隔离的另一半问题：**换机器 / 换目录会继承同样的脏数据**。磁盘上已有的脏条目不会
 * 因为代码修好了就消失，所以需要一道能扫出现存脏数据的检查。
 *
 * ─── 刻意只报告、绝不自动删 ───
 *
 * 删除用户数据必须**可见、可追**（谁能看见、什么时候删的、删了哪条），
 * 静默清理由程序替人决定"这不是你的记忆"太危险：名单误判一次就永久丢数据。
 * 所以本模块只产出报告项，删除动作交回用户。与 `/doctor --disk` 的取舍同源。
 *
 * ─── 为什么名单只认 frontmatter 的 `name`，不认正文 ───
 *
 * 用户可能在自己的记忆**正文**里引用 `doc_example`（比如记一条"测试怎么写的"），
 * 那是正常内容。只有 `name: doc_example` —— 即这条记忆**自己就以夹具 key 命名** ——
 * 才说明它是夹具泄漏出来的副本。
 */

import { join } from "path";
import { getSidHome } from "../config/paths.ts";
import { enumerateMemoryFiles, readMemoryFrontmatter } from "./scan.ts";

/**
 * 已知测试夹具 key 的最小集。
 *
 * 每条都要写清**来源文件**：名单会随时间腐化（测试改名/删除后 key 不再有出处），
 * 半年后有人看到 `doc_example` 无从判断它为何在里面。来源写在本表里，不放注释，
 * 是为了让报告能直接引用它。
 */
export const KNOWN_TEST_FIXTURE_KEYS: ReadonlyArray<{ key: string; source: string }> = [
  { key: "doc_example", source: "packages/core/tests/tool/memory.test.ts" },
];

/** 一条命中的夹具记忆。 */
export interface FixtureMemoryHit {
  /** 记忆条目自己的 key（frontmatter `name`） */
  key: string;
  /** 该 key 被认定为夹具的来源文件 */
  source: string;
  /** 绝对路径，便于用户在报告里直接定位后手动删除 */
  filePath: string;
}

/**
 * 扫描**全局记忆目录**（`getSidHome()/memory`），返回 key 命中夹具名单的条目。
 *
 * 只扫全局目录、不扫项目级 `projects/<key>/memory`：本次泄漏的路径是全局
 * （测试用例写的 `scope: "global"`），而项目级目录按 cwd 派生，doctor 的主诊断
 * 已有一条按 cwd 的路径检查；把两者混在一起会让「换一个仓库跑 doctor 就看不到」
 * 这种漏报出现在本该兜底的检查上。项目级要不要扫是另一个判据问题，见 Agent Note。
 *
 * 目录不存在 / 读不了时返回空数组：这是「没有脏数据」的正常形态，不应让 doctor 报错。
 */
export async function detectFixtureMemories(
  memoryDir: string = join(getSidHome(), "memory"),
): Promise<FixtureMemoryHit[]> {
  const known = new Map(KNOWN_TEST_FIXTURE_KEYS.map((e) => [e.key, e.source]));
  const rels = await enumerateMemoryFiles(memoryDir);
  const hits: FixtureMemoryHit[] = [];
  for (const rel of rels) {
    const filePath = join(memoryDir, rel);
    let text: string;
    try {
      text = await Bun.file(filePath).text();
    } catch {
      // 单条读不了不影响其它条目；静默跳过而不是整体失败——
      // 一条坏文件不该让整个自检变成"检查失败"。
      continue;
    }
    // 与 scan.ts 的 parseFrontmatter 同口径：先框出 frontmatter 块再读字段，
    // 否则正文里一行 `name: doc_example` 会被误判成夹具。
    const fm = readMemoryFrontmatter(text);
    const key = fm.name?.trim();
    if (!key) continue;
    const source = known.get(key);
    if (source) hits.push({ key, source, filePath });
  }
  return hits;
}
