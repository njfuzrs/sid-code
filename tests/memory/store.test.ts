/**
 * Auto Memory 存储测试（Task 1）
 * 使用临时目录，不污染真实 ~/.sid-code
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MemoryStore, clearMemorySummaryCache, inferMemoryType } from "../../src/memory/store.ts";

let tmpProject: string;
let projDir: string;
let globalDir: string;

/** 构造使用临时目录的 store，避免污染真实 ~/.sid-code */
function makeStore(): MemoryStore {
  return new MemoryStore(tmpProject, { projectMemoryDir: projDir, globalMemoryDir: globalDir });
}

beforeEach(() => {
  tmpProject = mkdtempSync(join(tmpdir(), "sid-mem-"));
  projDir = join(tmpProject, "mem-project");
  globalDir = join(tmpProject, "mem-global");
  clearMemorySummaryCache();
});

afterEach(() => {
  try { rmSync(tmpProject, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("MemoryStore — 文件系统后端", () => {
  test("set 写入 .md 文件并可 get 回来", async () => {
    const store = makeStore();
    await store.set("coding_style", "用 4 空格缩进", "project");

    const dir = store.getProjectMemoryDir()!;
    expect(existsSync(dir)).toBe(true);
    // 应至少有一个 .md 文件 + MEMORY.md
    const got = await store.get("coding_style");
    expect(got).not.toBeNull();
    expect(got!.value).toBe("用 4 空格缩进");
    expect(got!.scope).toBe("project");
    expect(got!.type).toBeDefined();
  });

  test("MEMORY.md 索引自动维护", async () => {
    const store = makeStore();
    await store.set("test_framework", "用 bun test", "project");
    const index = await store.getIndexContent();
    expect(index).not.toBeNull();
    expect(index).toContain("test_framework");
  });

  test("项目记忆覆盖全局记忆（同 key）", async () => {
    const store = makeStore();
    await store.set("lang", "全局值", "global");
    await store.set("lang", "项目值", "project");
    const got = await store.get("lang");
    expect(got!.value).toBe("项目值");
    expect(got!.scope).toBe("project");
  });

  test("delete 删除 .md 文件", async () => {
    const store = makeStore();
    await store.set("temp_key", "临时值", "project");
    expect(await store.get("temp_key")).not.toBeNull();
    const deleted = await store.delete("temp_key");
    expect(deleted).toBe(true);
    // 重新加载验证持久化删除
    const store2 = makeStore();
    expect(await store2.get("temp_key")).toBeNull();
  });

  test("search 按关键词匹配", async () => {
    const store = makeStore();
    await store.set("db_choice", "使用 PostgreSQL 数据库", "project");
    await store.set("cache", "Redis 缓存", "project");
    const results = await store.search("postgres");
    expect(results.length).toBe(1);
    expect(results[0].key).toBe("db_choice");
  });

  test("generateSummary 格式与旧实现一致", async () => {
    const store = makeStore();
    await store.set("k1", "v1", "project");
    const summary = await store.generateSummary();
    expect(summary).toContain("[项目] k1: v1");
  });

  test("空记忆 generateSummary 返回 null", async () => {
    const store = makeStore();
    const summary = await store.generateSummary();
    expect(summary).toBeNull();
  });

  test("持久化：新 store 实例能读到旧实例写的记忆", async () => {
    const store1 = makeStore();
    await store1.set("persist_test", "持久值", "project");
    const store2 = makeStore();
    const got = await store2.get("persist_test");
    expect(got!.value).toBe("持久值");
  });

  test("超长 value 被截断到 10000 字符", async () => {
    const store = makeStore();
    const long = "x".repeat(20000);
    await store.set("big", long, "project");
    const got = await store.get("big");
    expect(got!.value.length).toBe(10000);
  });

  test("显式 type 与 description 被保留", async () => {
    const store = makeStore();
    await store.set("u1", "后端工程师", "project", { type: "user", description: "角色画像" });
    const got = await store.get("u1");
    expect(got!.type).toBe("user");
    expect(got!.description).toBe("角色画像");
  });
});

describe("MemoryStore — 旧 JSON 迁移", () => {
  test("旧 memories.json 自动迁移为 .md + 备份", async () => {
    // 在新格式项目记忆目录写入旧 JSON
    mkdirSync(projDir, { recursive: true });
    const legacy = {
      version: "1.0",
      entries: {
        old_key: {
          key: "old_key",
          value: "迁移前的值",
          scope: "project",
          createdAt: 1000,
          updatedAt: 2000,
        },
      },
    };
    const legacyPath = join(projDir, "memories.json");
    writeFileSync(legacyPath, JSON.stringify(legacy));

    // 新 store 加载触发迁移
    const store2 = makeStore();
    const got = await store2.get("old_key");
    expect(got).not.toBeNull();
    expect(got!.value).toBe("迁移前的值");
    // 备份文件应存在，原文件应消失
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(legacyPath + ".bak")).toBe(true);
  });
});

describe("inferMemoryType — 启发式分类", () => {
  test("URL 类归为 reference", () => {
    expect(inferMemoryType("dashboard", "https://grafana.example.com")).toBe("reference");
  });
  test("偏好类归为 feedback", () => {
    expect(inferMemoryType("test_pref", "以后都用集成测试，不要 mock")).toBe("feedback");
  });
  test("角色类归为 user", () => {
    expect(inferMemoryType("profile", "我是后端工程师")).toBe("user");
  });
  test("默认归为 project", () => {
    expect(inferMemoryType("misc", "随便什么内容")).toBe("project");
  });
});

/**
 * 2026-07-30 回归：索引「指不到文件」的三个缺陷
 *
 * 事故形态：模型按注入的索引去 Read 记忆，报「文件不存在」。根因不是模型幻觉——
 * 索引里的文件名是 sid-code 自己拼错的（双类型前缀），且索引全程不给目录，
 * 模型只能猜路径。见 docs/_template/多任务报错.txt 排查。
 */
describe("MemoryStore — 索引可寻址性（2026-07-30 回归）", () => {
  /** 直接落盘一个记忆文件，绕过 set()，用于构造「存量脏文件名」 */
  function writeRaw(dir: string, filename: string, name: string, type: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, filename),
      `---\nname: ${name}\ndescription: 描述-${name}\ntype: ${type}\ncreated: 1\nupdated: 2\n---\n\n正文-${name}\n`,
    );
  }

  test("缺陷 A：索引每段带绝对目录，模型可直接拼出可 Read 的路径", async () => {
    const store = makeStore();
    await store.set("test_framework", "用 bun test", "project");
    const index = await store.getIndexContent();
    expect(index).not.toBeNull();
    // 目录必须出现且是绝对路径（旧版只有裸文件名，模型被迫猜目录）
    expect(index).toContain(projDir);
    // 「目录 + 链接文件名」必须真的落在磁盘上
    const link = index!.match(/\]\(([^)]+)\)/)?.[1];
    expect(link).toBeDefined();
    expect(existsSync(join(projDir, link!))).toBe(true);
  });

  test("缺陷 B：global scope 索引也注入（旧版只读 project，全局记忆永远进不了上下文）", async () => {
    const store = makeStore();
    await store.set("user_role", "后端工程师", "global");
    await store.set("test_framework", "用 bun test", "project");
    const index = await store.getIndexContent();
    expect(index).toContain("user_role");
    expect(index).toContain("test_framework");
    // 两段各自带自己的目录
    expect(index).toContain(globalDir);
    expect(index).toContain(projDir);
  });

  test("缺陷 B：仅有全局记忆时也返回索引（不再因无 projectDir 直接 null）", async () => {
    const onlyGlobal = new MemoryStore(undefined, { globalMemoryDir: globalDir });
    await onlyGlobal.set("user_role", "后端工程师", "global");
    const index = await onlyGlobal.getIndexContent();
    expect(index).not.toBeNull();
    expect(index).toContain("user_role");
  });

  test("缺陷 C：存量双前缀文件名被归一化，且索引同步重建为新名", async () => {
    // 构造事故现场：key 是 project_audit，文件名却被拼成 project_project-audit.md
    writeRaw(projDir, "project_project-audit.md", "project_audit", "project");
    writeFileSync(
      join(projDir, "MEMORY.md"),
      "# Memory Index\n\n- [project_audit](project_project-audit.md) — 旧索引\n",
    );

    const store = makeStore();
    const index = await store.getIndexContent();

    // 文件已改名
    expect(existsSync(join(projDir, "project_audit.md"))).toBe(true);
    expect(existsSync(join(projDir, "project_project-audit.md"))).toBe(false);
    // 索引不再指向已消失的旧名（否则等于自己造出「文件不存在」）
    expect(index).not.toContain("project_project-audit.md");
    const link = index!.match(/\]\(([^)]+)\)/)?.[1];
    expect(existsSync(join(projDir, link!))).toBe(true);
    // 内容没丢。注意 key 也被第二步归一化了（project_audit → audit），
    // 所以按新 key 取——这正是 C-2 期望的行为。
    expect((await store.get("audit"))!.value).toBe("正文-project_audit");
  });

  test("缺陷 C：归一化不误伤正常语义名，且幂等", async () => {
    writeRaw(projDir, "project_projection-matrix.md", "projection-matrix", "project");
    writeRaw(projDir, "reference_doc-example.md", "doc_example", "reference");

    await makeStore().load();
    expect(existsSync(join(projDir, "project_projection-matrix.md"))).toBe(true);
    expect(existsSync(join(projDir, "reference_doc-example.md"))).toBe(true);

    // 二次加载不再改名（幂等）
    await makeStore().load();
    expect(existsSync(join(projDir, "project_projection-matrix.md"))).toBe(true);
    expect(existsSync(join(projDir, "reference_doc-example.md"))).toBe(true);
  });

  test("缺陷 C：目标文件名已存在时跳过改名，不覆盖用户数据", async () => {
    writeRaw(projDir, "project_project-audit.md", "project_audit", "project");
    writeRaw(projDir, "project_audit.md", "audit", "project");

    await makeStore().load();
    // 两个文件都还在——宁可留着旧名，也不能覆盖掉同名的另一条记忆
    expect(existsSync(join(projDir, "project_project-audit.md"))).toBe(true);
    expect(existsSync(join(projDir, "project_audit.md"))).toBe(true);
  });

  test("set 新记忆时 key 自带类型前缀不再产出双前缀（根因修复）", async () => {
    const store = makeStore();
    await store.set("project_my-thing", "值", "project");
    expect(existsSync(join(projDir, "project_my-thing.md"))).toBe(true);
    expect(existsSync(join(projDir, "project_project-my-thing.md"))).toBe(false);
  });

  /**
   * 缺陷 C 的另一半：`name:` frontmatter 里残留的类型前缀。
   *
   * 改文件名只治了一半——key 来自 frontmatter 的 name，`name: project_xxx` 会继续
   * 把带前缀的 key 灌进索引。实测 7 条残留里 4 条的前缀与文件真实 type **矛盾**
   * （key 声称 project，文件却在 reference_*.md 里），属会误导分类判断的脏数据。
   *
   * 注意边界：本组只清「key 混进类型前缀」，不强求 key == 文件名——对标实现
   * （claude-code memdir）的索引行本就是 `- [Title](file.md)`，方括号是人类可读
   * 标题、天然不等于文件名。
   */
  test("缺陷 C-2：清掉 name frontmatter 里残留的类型前缀", async () => {
    writeRaw(projDir, "user_reminder-order.md", "project_reminder-order", "user");

    const store = makeStore();
    const index = await store.getIndexContent();

    // key 已归一化，索引方括号里不再出现类型前缀
    expect(index).toContain("[reminder-order]");
    expect(index).not.toContain("[project_reminder-order]");
    // 能按新 key 取到，内容没丢
    expect((await store.get("reminder-order"))!.value).toBe("正文-project_reminder-order");
  });

  test("缺陷 C-2：不动 key 本就不带前缀的条目（命名方案固有差异，非 bug）", async () => {
    writeRaw(projDir, "reference_doc-example.md", "doc_example", "reference");

    const store = makeStore();
    await store.load();
    // name 字段原样保留（没有类型前缀可剥）
    expect(readFileSync(join(projDir, "reference_doc-example.md"), "utf8"))
      .toContain("name: doc_example");
    expect(await store.get("doc_example")).not.toBeNull();

    // 索引里方括号 ≠ 文件名是允许的，不该被"修"成一致
    await store.set("other", "触发索引重建", "project");
    expect(await store.getIndexContent()).toContain("[doc_example](reference_doc-example.md)");
  });

  test("缺陷 C-2：key 整体就是类型词时保留原值，不清成空", async () => {
    writeRaw(projDir, "project_only.md", "project", "project");

    const store = makeStore();
    await store.load();
    // 剥完为空 → 保留原值，不能把 key 清成空串
    expect(readFileSync(join(projDir, "project_only.md"), "utf8")).toContain("name: project");
    expect(await store.get("project")).not.toBeNull();
  });

  test("缺陷 C-2：幂等——二次加载不再改动 name 字段", async () => {
    writeRaw(projDir, "user_reminder-order.md", "project_reminder-order", "user");
    await makeStore().load();
    const first = readFileSync(join(projDir, "user_reminder-order.md"), "utf8");
    await makeStore().load();
    expect(readFileSync(join(projDir, "user_reminder-order.md"), "utf8")).toBe(first);
  });

  test("缺陷 C-2：只改 name，正文与其他 frontmatter 字段不动", async () => {
    writeRaw(projDir, "user_reminder-order.md", "project_reminder-order", "user");
    await makeStore().load();
    const text = readFileSync(join(projDir, "user_reminder-order.md"), "utf8");
    expect(text).toContain("name: reminder-order");
    expect(text).toContain("type: user");
    expect(text).toContain("created: 1");
    expect(text).toContain("正文-project_reminder-order");
  });
});

/**
 * P0-b②：索引摘要写入端剥离 markdown 结构标记。
 *
 * 事故（2026-07-29，轨迹 20260729-180624-b8ae8e78）：desc 缺省时回退取正文首行，而
 * 记忆正文首行绝大多数是 markdown 标题。于是 MEMORY.md 索引里出现
 * `— ## 负收益防线审计第 2 版完成（2026-07-30）`，随 system prompt 注入每个会话后，
 * 模型把它当成"用户刚说的话"，用户只输入 `/commit` 却第一轮跑去 glob 那条记忆文件。
 *
 * 这是**根治点**：写入端修掉后 MEMORY.md 文件本身就是干净的，不依赖渲染端逐行补救
 * （渲染端另有一层兜底，见 tests/memory/prompt-injection.test.ts 的 P0-b① 段）。
 */
describe("MemoryStore — 索引摘要去 markdown 标记（P0-b②）", () => {
  test("正文首行是 `## 标题` 时，索引摘要剥离标题标记", async () => {
    const store = makeStore();
    await store.set(
      "negative-return-audit",
      "## 负收益防线审计第 2 版完成（2026-07-30）\n\n详细结论见正文。",
      "project",
    );
    const index = readFileSync(join(projDir, "MEMORY.md"), "utf8");
    expect(index).not.toContain("## 负收益防线审计");
    expect(index).toContain("负收益防线审计第 2 版完成");
  });

  test("frontmatter 里的 description 同样剥离（不只是索引）", async () => {
    const store = makeStore();
    await store.set("audit", "### 三级标题式正文首行\n\n正文", "project");
    const files = require("fs").readdirSync(projDir).filter((f: string) => f !== "MEMORY.md");
    const text = readFileSync(join(projDir, files[0]), "utf8");
    expect(text).toContain("description: 三级标题式正文首行");
    // 正文本身不动——剥的只是摘要，原始 markdown 结构必须完整保留
    expect(text).toContain("### 三级标题式正文首行");
  });

  test("剥离列表 / 引用 / 强调标记", async () => {
    const store = makeStore();
    await store.set("a", "- 列表式首行\n\n正文", "project");
    await store.set("b", "> 引用式首行\n\n正文", "project");
    await store.set("c", "**Why:** 强调式首行\n\n正文", "project");
    const index = readFileSync(join(projDir, "MEMORY.md"), "utf8");
    expect(index).toContain("— 列表式首行");
    expect(index).toContain("— 引用式首行");
    expect(index).toContain("— Why: 强调式首行");
  });

  test("正文以空行开头时取第一个非空行（原实现会得到空摘要）", async () => {
    const store = makeStore();
    await store.set("blank-lead", "\n\n## 真正的首行\n\n正文", "project");
    const index = readFileSync(join(projDir, "MEMORY.md"), "utf8");
    expect(index).toContain("真正的首行");
    expect(index).not.toMatch(/—\s*$/m); // 不出现空摘要的裸分隔符
  });

  test("显式传入的 description 优先，且同样被剥离", async () => {
    const store = makeStore();
    await store.set("explicit", "正文首行", "project", { description: "## 显式摘要" });
    const index = readFileSync(join(projDir, "MEMORY.md"), "utf8");
    expect(index).toContain("显式摘要");
    expect(index).not.toContain("## 显式摘要");
  });

  test("读侧兜底：旧文件 frontmatter 已存 `## 标题` 时，重建索引也剥离", async () => {
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, "project_legacy.md"),
      "---\nname: legacy\ndescription: ## 修复前写入的陈述句标题\ntype: project\ncreated: 1\nupdated: 2\n---\n\n## 修复前写入的陈述句标题\n\n正文\n",
    );
    const store = makeStore();
    // 触发一次写入 → 索引重建，旧条目一起被重新渲染
    await store.set("trigger", "无关内容", "project");
    const index = readFileSync(join(projDir, "MEMORY.md"), "utf8");
    expect(index).toContain("修复前写入的陈述句标题");
    expect(index).not.toContain("## 修复前写入的陈述句标题");
  });
});
