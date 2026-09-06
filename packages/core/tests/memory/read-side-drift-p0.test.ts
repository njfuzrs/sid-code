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
        createdAt: 0,
        updatedAt: Date.now(),
      },
    ],
  ]);

  test("超过 1 天的条目带上相对天数（模型不擅长算日期差，所以给的是「N days ago」）", () => {
    const out = annotateIndexAges("- [old](reference_old.md) — 某条结论", entries);
    expect(out).toContain("⏳");
    expect(out).toContain(memoryAge(entries.get("old")!.updatedAt));
    // 摘要与链接都要保留，注解是追加而非替换
    expect(out).toContain("[old](reference_old.md)");
    expect(out).toContain("某条结论");
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

  test("与 buildFreshnessWarning 同判据：1 天为界（不是两套阈值）", () => {
    // 这条钉住「注解阈值」与「警告阈值」同源。分叉了就会出现
    // 「索引说 today、警告说 1 day old」这种自相矛盾的注入。
    const justOver = Date.now() - (DAY + 1000);
    expect(memoryAgeDays(justOver)).toBe(1);
    const m = new Map([
      ["k", { key: "k", value: "v", scope: "project" as const, createdAt: 0, updatedAt: justOver }],
    ]);
    expect(annotateIndexAges("- [k](reference_k.md) — x", m)).toContain("⏳");
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

  test("app 层实现里查了 flag、调了 findRelevantMemories、也用了召回附件", async () => {
    const src = await Bun.file(join(import.meta.dir, "../../../cli/src/app.ts")).text();
    const has = (n: string) => src.includes(n);
    // 三者缺一，那条链路就还是断的：
    expect(has("drainRecalledMemories:")).toBe(true); // 接线点
    expect(has("isMemoryRecallEnabled()")).toBe(true); // flag 真的被查询
    expect(has("findRelevantMemories(")).toBe(true); // 召回真的被调用
    expect(has("generateRecalledMemoryAttachment(")).toBe(true); // 附件真的被使用
  });

  test("freshness 在索引注入路径上有生产引用（此前唯一引用在零接线的 recall.ts 内）", async () => {
    const src = await Bun.file(join(import.meta.dir, "../../src/memory/store.ts")).text();
    expect(src.includes('from "./freshness.ts"')).toBe(true);
  });
});
