/**
 * P0-3 防复发：读取侧防漂移链路必须真的可达
 *
 * 参考文档的主线论点是「漂移不可能在存储层根治，防御全部押在读取侧」。
 * sid-code 把那套东西**实现了**（freshness.ts / recall.ts / recalledMemories /
 * PRIORITY.MEMORY_RECALLED），**单测也齐**，但修复前**生产路径上一个调用者都没有**——
 * 正是 CLAUDE.md 北极星点名的失效模式：「防线全在、调用全零」。
 *
 * 所以这个文件的断言分两类，缺一不可：
 * ① 行为断言：年龄标记真的出现在注入内容里；
 * ② **接线断言**：生产调用点真的存在（读源码文本）。
 *    只有 ① 的话，修复前那套代码同样能让 ① 全绿——它们本来就实现正确，
 *    坏的从来不是实现，是没人调用。
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  MemoryStore,
  clearMemorySummaryCache,
  annotateIndexAges,
  type MemoryEntry,
} from "@sid-code/core/memory/store.ts";
import { buildMemorySystemPrompt } from "@sid-code/core/memory/prompt.ts";
import { memoryAge, memoryAgeDays } from "@sid-code/core/memory/freshness.ts";

const DAY = 24 * 60 * 60 * 1000;

let tmpProject: string;
let projDir: string;
let globalDir: string;
let tmpHome: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-drift-home-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
});

afterAll(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  tmpProject = mkdtempSync(join(tmpdir(), "sid-drift-"));
  projDir = join(tmpProject, "mem-project");
  globalDir = join(tmpProject, "mem-global");
  clearMemorySummaryCache();
});

afterEach(() => {
  try {
    rmSync(tmpProject, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeMem(
  dir: string,
  filename: string,
  opts: { name: string; description: string; updated: number },
): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, filename),
    [
      "---",
      `name: ${opts.name}`,
      `description: ${opts.description}`,
      "type: reference",
      `created: ${opts.updated}`,
      `updated: ${opts.updated}`,
      "---",
      "",
      "正文",
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("annotateIndexAges：把年龄带进索引行", () => {
  const entries = new Map([
    [
      "old",
      {
        key: "old",
        value: "v",
        scope: "project" as const,
        // P0-3 起 MemoryEntry.source 必填；本用例只验索引年龄注解，取缺省档即可
        source: "inferred" as const,
        createdAt: 0,
        updatedAt: Date.now() - 47 * DAY,
      },
    ],
    [
      "fresh",
      {
        key: "fresh",
        value: "v",
        scope: "project" as const,
        source: "inferred" as const,
        createdAt: 0,
        updatedAt: Date.now(),
      },
    ],
    // T2-2（2026-11-15）：标注口径从「超过 1 天」改成「索引里最旧的一批（30%）」，
    // 配额 = floor(n × 0.3)，n=4 时恰好 1 条 —— 加两条中年条目让 `old` 成为唯一的最旧。
    [
      "mid20",
      {
        key: "mid20",
        value: "v",
        scope: "project" as const,
        source: "inferred" as const,
        createdAt: 0,
        updatedAt: Date.now() - 20 * DAY,
      },
    ],
    [
      "mid10",
      {
        key: "mid10",
        value: "v",
        scope: "project" as const,
        source: "inferred" as const,
        createdAt: 0,
        updatedAt: Date.now() - 10 * DAY,
      },
    ],
  ]);

  test("最旧的一批带上相对天数（模型不擅长算日期差，所以给的是「N days ago」）", () => {
    const out = annotateIndexAges(
      [
        "- [old](reference_old.md) — 某条结论",
        "- [mid20](reference_mid20.md) — 20 天前",
        "- [mid10](reference_mid10.md) — 10 天前",
        "- [fresh](reference_fresh.md) — 刚写的",
      ].join("\n"),
      entries,
    );
    expect(out).toContain("⏳");
    expect(out).toContain(memoryAge(entries.get("old")!.updatedAt));
    // 摘要与链接都要保留，注解是追加而非替换
    expect(out).toContain("[old](reference_old.md)");
    expect(out).toContain("某条结论");
    // 只有最旧那条带标记：其余三条没有 —— 这正是「区分度」的定义
    const lines = out.split("\n");
    expect(lines[0]).toContain("⏳");
    expect(lines.slice(1).every((l) => !l.includes("⏳"))).toBe(true);
  });

  test("当天写的不加标记（否则纯噪声，且每天击穿一次 prompt cache）", () => {
    const out = annotateIndexAges("- [fresh](reference_fresh.md) — 刚写的", entries);
    expect(out).not.toContain("⏳");
  });

  test("索引里有、内存里没有的行不编造年龄", () => {
    const line = "- [orphan](reference_orphan.md) — 孤儿行";
    expect(annotateIndexAges(line, entries)).toBe(line);
  });

  test("非条目行（段标题 / 空行 / 截断警告）原样保留", () => {
    const text = "# Memory Index\n\n> ⚠️ 索引已截断\n";
    expect(annotateIndexAges(text, entries)).toBe(text);
  });

  test("最旧的一批里 1 天内的不标（与 buildFreshnessWarning 同判据）", () => {
    // T2-2（2026-11-15）起「是否标」由分位决定，但「1 天内不标」仍是硬判据 ——
    // 否则一条刚写的记忆只要恰好是库里最旧的，就会被打上 `⏳today` 这种纯噪声。
    // 与 `buildFreshnessWarning` 的分界保持同源，避免出现
    // 「索引说 today、Read 时不提醒」这种自相矛盾的注入。
    const justOver = Date.now() - (DAY + 1000);
    expect(memoryAgeDays(justOver)).toBe(1);
    const fresh = Date.now();
    const mk = (key: string, updatedAt: number): [string, MemoryEntry] => [
      key,
      {
        key,
        value: "v",
        scope: "project",
        source: "inferred",
        createdAt: 0,
        updatedAt,
      },
    ];
    // 4 条 → 配额 1；`k` 是唯一的最旧（1 天多），其余是当天
    const m = new Map<string, MemoryEntry>([
      mk("k", justOver),
      mk("a", fresh),
      mk("b", fresh),
      mk("c", fresh),
    ]);
    const out = annotateIndexAges(
      ["- [k](reference_k.md) — x", "- [a](a.md) — a", "- [b](b.md) — b", "- [c](c.md) — c"].join(
        "\n",
      ),
      m,
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("⏳"); // 最旧的（1 天多）标
    expect(lines.slice(1).join("\n")).not.toContain("⏳"); // 当天的三条不标
  });
});

describe("getIndexContent：年龄真的到达注入内容（端到端）", () => {
  test("旧记忆在注入的索引里带年龄标记", async () => {
    // 这是 P0-3 的核心行为断言：修复前索引注入路径**完全不带年龄信息**，
    // 而模型 Read 出正文时 stripFrontmatter 又把 updated: 剥掉了 ——
    // 净效果是模型看到的每条记忆都是无时间戳的陈述句。
    writeMem(projDir, "reference_stale.md", {
      name: "stale",
      description: "某个已修复的结论",
      updated: Date.now() - 47 * DAY,
    });
    // T2-2（2026-11-15）：标注口径改成「索引里最旧的一批（30%）」，配额 = floor(n × 0.3)。
    // 只写 1 条会让配额为 0（floor(0.3) = 0）—— 必须凑到 ≥4 条，stale 才落在「最旧的一批」里。
    for (const name of ["fresh-a", "fresh-b", "fresh-c"]) {
      writeMem(projDir, `reference_${name}.md`, {
        name,
        description: `${name} 的新记忆`,
        updated: Date.now(),
      });
    }
    // 索引文件本身要存在（getIndexContent 读的是磁盘索引）
    const store = new MemoryStore(tmpProject, {
      projectMemoryDir: projDir,
      globalMemoryDir: globalDir,
    });
    await store.set("trigger", "触发索引重建", "project");

    const index = await store.getIndexContent();
    expect(index).not.toBeNull();
    expect(index!).toContain("[stale]");
    expect(index!).toContain("⏳");
  });

  test("注入的 system prompt 同时带年龄标记与新鲜度判据措辞", async () => {
    // 光有天数是给了数据没给判据；光有措辞则模型无从判断哪条更可疑。两者必须成对。
    writeMem(projDir, "reference_stale.md", {
      name: "stale",
      description: "某个已修复的结论",
      updated: Date.now() - 47 * DAY,
    });
    // T2-2（2026-11-15）：标注口径改成「索引里最旧的一批（30%）」，配额 = floor(n × 0.3)。
    // 只写 1 条会让配额为 0（floor(0.3) = 0）—— 必须凑到 ≥4 条，stale 才落在「最旧的一批」里。
    for (const name of ["fresh-a", "fresh-b", "fresh-c"]) {
      writeMem(projDir, `reference_${name}.md`, {
        name,
        description: `${name} 的新记忆`,
        updated: Date.now(),
      });
    }
    const store = new MemoryStore(tmpProject, {
      projectMemoryDir: projDir,
      globalMemoryDir: globalDir,
    });
    await store.set("trigger", "触发索引重建", "project");

    const prompt = buildMemorySystemPrompt(await store.getIndexContent());

    // ⚠️ 不能只断言 prompt 里有 "⏳"：那个字符**也出现在静态说明文字里**
    //（`格式：- [键名](文件名) ⏳多久之前 …`），所以裸断言 marker 是**空断言** ——
    // 实测把索引注解整段去掉后这条依然全绿。必须断言「真实那条记忆的行上」带着
    // 真实算出来的年龄，才分得清「说明文案」与「真的注入了数据」。
    const staleLine = prompt.split("\n").find((l) => l.includes("[stale]"));
    expect(staleLine).toBeDefined();
    expect(staleLine!).toContain("⏳");
    expect(staleLine!).toContain(memoryAge(Date.now() - 47 * DAY));

    // 判据措辞：必须点明「越旧越可疑、用前先核实」这个方向
    expect(prompt).toContain("写入当时");
    expect(prompt).toContain("核实");
  });
});

describe("接线层：语义召回不再是「防线全在、调用全零」", () => {
  test("loop.ts 有 drainRecalledMemories 的生产调用点", async () => {
    const src = await Bun.file(join(import.meta.dir, "../../src/query/loop.ts")).text();
    const has = (n: string) => src.includes(n); // 大文件，避免 toContain 打印全文
    expect(has("deps.drainRecalledMemories")).toBe(true);
    // 只在每条用户消息首轮召回一次：每轮召回等于把成本乘上轮数却拿不到新信息
    expect(has("state.turnCount === 1 && deps.drainRecalledMemories")).toBe(true);
  });

  test("engine 转发该 dep（漏转发 = 接线断在中间一层）", async () => {
    const src = await Bun.file(join(import.meta.dir, "../../src/query/engine.ts")).text();
    expect(src.includes("drainRecalledMemories: this.deps.drainRecalledMemories")).toBe(true);
  });

  test("app 层实现里查了注入模式、调了 findRelevantMemories、也用了召回附件", async () => {
    const src = await Bun.file(join(import.meta.dir, "../../../cli/src/app.ts")).text();
    const has = (n: string) => src.includes(n);
    // 三者缺一，那条链路就还是断的：
    expect(has("drainRecalledMemories:")).toBe(true); // 接线点
    // 模式真的被查询（F5 / PR-4 起由 inject-mode 判定，取代原 env flag）
    expect(has("resolveMemoryInjectMode(memoryDir).mode")).toBe(true);
    expect(has("findRelevantMemories(")).toBe(true); // 召回真的被调用
    expect(has("generateRecalledMemoryAttachment(")).toBe(true); // 附件真的被使用
  });

  test("freshness 在索引注入路径上有生产引用（此前唯一引用在零接线的 recall.ts 内）", async () => {
    const src = await Bun.file(join(import.meta.dir, "../../src/memory/store.ts")).text();
    expect(src.includes('from "./freshness.ts"')).toBe(true);
  });
});
