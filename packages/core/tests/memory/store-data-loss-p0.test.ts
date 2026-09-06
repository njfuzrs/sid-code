/**
 * P0-1 / P0-2 防复发：两条会真丢用户数据的路径
 *
 * 这两条都不是构造出来的边界场景：
 * - P0-1（重名 `name:` → 记忆静默丢失）**已在本仓库真实记忆库里发生**
 *   （111 个 `.md` 但索引只有 110 条指针）；
 * - P0-2（第 201 条写入静默 unlink 最旧记忆）当时距触发只差 89 条。
 *
 * ⚠️ 这些用例的价值全在**它们会不会因为回退而变红**。写的时候都做了变异自证：
 * 把 store.ts 的修复注释掉后逐条确认变红，避免留下「绿了但没测到」的空断言
 * （仓库教训：门禁单测锁住想象中的实现）。
 *
 * 隔离口径与 store.test.ts 一致：SID_CONFIG_DIR + 显式传两个目录覆盖。
 * 只传构造参数不算隔离——那个参数是项目标识，不是落盘目录。
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MemoryStore, clearMemorySummaryCache } from "@sid-code/core/memory/store.ts";
import { MEMORY_LIMITS } from "@sid-code/core/memory/types.ts";

let tmpProject: string;
let projDir: string;
let globalDir: string;
let tmpHome: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-mem-p0-home-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
});

afterAll(() => {
  // 存/恢复原值，不无条件 delete（同进程多文件，delete 会抹掉 preload 兜底）
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  tmpProject = mkdtempSync(join(tmpdir(), "sid-mem-p0-"));
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

function makeStore(): MemoryStore {
  return new MemoryStore(tmpProject, { projectMemoryDir: projDir, globalMemoryDir: globalDir });
}

/** 造一个带 frontmatter 的记忆文件（updated 显式给值，用于断定胜者） */
function writeMemFile(
  dir: string,
  filename: string,
  opts: { name: string; description: string; body: string; updated: number },
): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const text = [
    "---",
    `name: ${opts.name}`,
    `description: ${opts.description}`,
    "type: reference",
    `created: ${opts.updated}`,
    `updated: ${opts.updated}`,
    "---",
    "",
    opts.body,
    "",
  ].join("\n");
  writeFileSync(join(dir, filename), text, "utf8");
}

describe("P0-1 重名 frontmatter name: 不再静默丢一半", () => {
  test("撞 key 时取 updated 更新的那条，且被遮蔽的文件仍在磁盘上", async () => {
    // 复刻真实事故的形态：两个文件、同一个 name:，相隔几分钟写入，
    // 第二次本意是「更新」，实际落成了第二个文件。
    writeMemFile(projDir, "reference_dup.md", {
      name: "dup",
      description: "A版-原始结论",
      body: "问题现象与复现方式",
      updated: 1_000,
    });
    writeMemFile(projDir, "reference_dup-1.md", {
      name: "dup",
      description: "B版-后续更正",
      body: "已修复",
      updated: 2_000,
    });

    const store = makeStore();
    await store.load();

    // 内存视角仍是 1 条（重名本身无法让两条共存，key 是唯一主键）
    const got = await store.get("dup");
    expect(got).not.toBeNull();
    // 关键：胜者由 updatedAt 决定，不再取决于 readdir 顺序
    expect(got!.description).toBe("B版-后续更正");

    // 关键：被遮蔽的那个文件**没有被删**，字节还在
    expect(existsSync(join(projDir, "reference_dup.md"))).toBe(true);
    expect(existsSync(join(projDir, "reference_dup-1.md"))).toBe(true);
  });

  test("重名状态经 listShadowedFiles 可见（旧实现下这里恒为空）", async () => {
    writeMemFile(projDir, "reference_dup.md", {
      name: "dup",
      description: "A版",
      body: "正文 A",
      updated: 1_000,
    });
    writeMemFile(projDir, "reference_dup-1.md", {
      name: "dup",
      description: "B版",
      body: "正文 B",
      updated: 2_000,
    });

    const store = makeStore();
    const shadowed = await store.listShadowedFiles();

    // 这条是本次修复的**唯一**可发现出口：list()/getStats() 都是内存视角，
    // 重名时报的是去重后的数字，看不出磁盘上还有一个孤儿。
    expect(shadowed.length).toBe(1);
    expect(shadowed[0].key).toBe("dup");
    expect(shadowed[0].filename).toBe("reference_dup.md"); // 输的是 updated 更小的那个
    expect(shadowed[0].scope).toBe("project");
  });

  test("加载结果与 readdir 顺序无关：同一份磁盘重复加载得到同一个胜者", async () => {
    writeMemFile(projDir, "reference_dup.md", {
      name: "dup",
      description: "A版",
      body: "正文 A",
      updated: 1_000,
    });
    writeMemFile(projDir, "reference_dup-1.md", {
      name: "dup",
      description: "B版",
      body: "正文 B",
      updated: 2_000,
    });

    for (let i = 0; i < 3; i++) {
      const store = makeStore();
      await store.load();
      const got = await store.get("dup");
      expect(got!.description).toBe("B版");
    }
  });

  test("无重名时 listShadowedFiles 为空（反向自证：不是恒返回非空）", async () => {
    const store = makeStore();
    await store.set("alpha", "内容 A", "project");
    await store.set("beta", "内容 B", "project");
    expect((await store.listShadowedFiles()).length).toBe(0);
  });

  test("写入侧：不覆盖内存映射里没有、但磁盘上真实存在的别人的记忆", async () => {
    // 这是写入侧修复真正守住的状态：**磁盘上有、内存 files 映射里没有**。
    // 它不是构造场景——`MemoryStore` 生产有 8 个独立实例且 `loaded` 永不失效
    // （缺陷 11），所以「本实例 load 完之后，别的实例/后台提取代理又写了新文件」
    // 是常态。此时本实例的 files 映射对那个文件一无所知。
    //
    // 旧实现的撞名循环只查 `files.values()`（空）⇒ 直接 Bun.write 覆盖，
    // 别人那条记忆连内容带 frontmatter 一起被顶掉，且全程无日志。
    const store = makeStore();
    await store.load(); // 此刻目录是空的 → files 映射为空，且 loaded 永不失效

    // 模拟「另一个实例/后台代理」写进来一条记忆，文件名恰好会与下面的 key 派生撞上
    writeMemFile(projDir, "reference_taken.md", {
      name: "someone-else",
      description: "别人的记忆",
      body: "不要动我",
      updated: 1_000,
    });

    await store.set("taken", "我的记忆", "project", { type: "reference" });

    // 关键：别人那条记忆的字节没被覆盖
    const survivor = await Bun.file(join(projDir, "reference_taken.md")).text();
    expect(survivor).toContain("name: someone-else");
    expect(survivor).toContain("不要动我");

    // 我的记忆落在了让路后的文件名上
    expect(existsSync(join(projDir, "reference_taken-1.md"))).toBe(true);
    const mine = await Bun.file(join(projDir, "reference_taken-1.md")).text();
    expect(mine).toContain("name: taken");
    expect(mine).toContain("我的记忆");
  });

  test("同 key 时认领原文件，不制造第二个同名文件", async () => {
    // 与上一条相反的分支：磁盘上那个文件就是本 key 自己的记忆（同样不在内存映射里）。
    // 此时必须**认领并更新**它，而不是加后缀落出第二个 `name: solo`。
    //
    // ⚠️ 诚实标注：这条在「把 diskNameOf 判据整段删掉」的变异下**不会变红** ——
    // 旧代码在这个分支恰好也覆盖同一个文件名，结果殊途同归。它守的是
    // `diskNameOf(...) === key ⇒ break` 这半边不被改成「无条件加后缀」
    // （那才是造出重名的走法）。留着它是为了钉住这个分支的语义，
    // 但**别把它当成写入侧的主门禁** —— 主门禁是上一条。
    const store = makeStore();
    await store.load(); // files 映射为空

    writeMemFile(projDir, "reference_solo.md", {
      name: "solo",
      description: "第一版",
      body: "第一版内容",
      updated: 1_000,
    });

    await store.set("solo", "第二版内容", "project", { type: "reference" });

    const mdFiles = readdirSync(projDir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    // 仍然只有一个文件：更新就是更新
    expect(mdFiles).toEqual(["reference_solo.md"]);
    expect(existsSync(join(projDir, "reference_solo-1.md"))).toBe(false);

    const got = await store.get("solo");
    expect(got!.value).toBe("第二版内容");
    // 且没有制造出新的重名
    expect((await store.listShadowedFiles()).length).toBe(0);
  });
});

describe("P0-2 超限时归档而非静默删除", () => {
  test("第 201 条写入后，最旧的记忆文件被移进 archive/ 而不是消失", async () => {
    const store = makeStore();
    const limit = MEMORY_LIMITS.STORE_MAX_ENTRIES;

    // 写满上限。updatedAt 递增，k000 是最旧的一条。
    for (let i = 0; i < limit; i++) {
      await store.set(`k${String(i).padStart(3, "0")}`, `内容 ${i}`, "project");
    }
    const oldestFile = "project_k000.md";
    expect(existsSync(join(projDir, oldestFile))).toBe(true);

    // 越过上限
    await store.set("k200", "越过上限的那一条", "project");

    // 关键：原位置已不在（被移走），但**字节没丢**——在 archive/ 里
    expect(existsSync(join(projDir, oldestFile))).toBe(false);
    expect(existsSync(join(projDir, "archive", oldestFile))).toBe(true);

    // 索引里不再列它（归档 = 移出索引，这部分行为不变）
    const index = await store.getIndexContent();
    expect(index).not.toContain("[k000]");
  });

  test("归档目录不参与后续扫描与条数统计（archive/ 在 SKIP_DIRS 里）", async () => {
    const store = makeStore();
    const limit = MEMORY_LIMITS.STORE_MAX_ENTRIES;
    for (let i = 0; i < limit + 1; i++) {
      await store.set(`k${String(i).padStart(3, "0")}`, `内容 ${i}`, "project");
    }

    const stats = await store.getStats();
    // 归档过的不再计入，所以恒等于上限而不是 limit+1
    expect(stats.projectCount).toBe(limit);

    // 归档区确实存了东西（反向自证：上面那个等式不是因为「压根没超限」才成立）
    expect(existsSync(join(projDir, "archive"))).toBe(true);
    expect(readdirSync(join(projDir, "archive")).length).toBeGreaterThan(0);
  });

  test("SCAN_MAX_FILES 与 STORE_MAX_ENTRIES 是两个常量（语义不同，不许再共用）", () => {
    // 这条是防漂移哨兵：两者当前取值相同，但契约相反——
    // 前者截断「一次读几个」（不动磁盘），后者决定「磁盘上留几个」（会动文件）。
    // 合回一个常量会让「调大扫描上限」变成「调大磁盘保留量」，或反之误删数据。
    expect(MEMORY_LIMITS).toHaveProperty("SCAN_MAX_FILES");
    expect(MEMORY_LIMITS).toHaveProperty("STORE_MAX_ENTRIES");
  });
});
