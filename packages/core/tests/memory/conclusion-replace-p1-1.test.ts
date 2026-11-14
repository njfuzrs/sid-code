/**
 * P1-1（MD3）：索引已满时，同 key 更新的「结论级替换」必须留痕
 *
 * ## 缺陷背景
 *
 * 后台提取代理把新事实写进**同一个 key**，旧条目的主题陈述被静默替换：磁盘上那条记忆
 * 的标题还是旧的，正文讲的已经是另一件事。索引已截断时这个问题被放大 —— 新建 key
 * 大多直接成为「磁盘上有、模型看不见」的孤儿，写入压力全压到既有 key 上。
 *
 * ## 本文件钉住的判据（T-M5）
 *
 * - **T-M5a**：索引已满 + 同 key 更新换掉首行结论 + 无 `推翻：`/`纠正：` → 被拒，
 *   且**磁盘上没有被改写**。
 * - **T-M5b**：同一场景下，`save_memory` 与 `edit` / `write` **两条路径都要被拒**。
 *   只挡一条等于没挡 —— 模型被 `save_memory` 拒了之后换条路就绕过（P0-4 的回告里
 *   已经把这条绕过面写明）。
 * - **T-M5c（不误伤）**：带 `推翻：` / `纠正：` → 放行；保留旧首行结论的细节级更新 →
 *   放行；索引**未**满 → 放行；非记忆路径 → 放行（闸门不做全局内容审查）。
 * - **T-M5d**：「更新：」「补充：」不算声明（它们和「追加」是同一个意思）。
 *
 * ## 变异自证（本文件逐条确认过）
 *
 * - 把 `hasOverturnMarker` 改成恒 `true` → T-M5a 变红；
 * - 把 `findConclusionReplacement` 的「旧结论还在」分支去掉 → T-M5c 的细节级更新变红；
 * - 把 `edit.ts` / `write.ts` 里的 `checkMemoryConclusionReplace` 调用删掉 → T-M5b 变红；
 * - 把 `readIndexCapacity(...).truncated` 判据去掉 → 「索引未满放行」变红。
 *
 * ## 隔离
 *
 * 落盘全部指向 tmpdir：`SID_CONFIG_DIR` 指临时目录（`getAutoMemPath` 的派生根），
 * `MemoryStore` 另外显式传 `projectMemoryDir` / `globalMemoryDir`。env 存/恢复原值，
 * 不无条件 delete（同批多文件跑在同一进程里，delete 会抹掉 preload 兜底）。
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MemoryStore, clearMemorySummaryCache } from "@sid-code/core/memory/store.ts";
import { MemoryTool } from "@sid-code/core/tool/memory.ts";
import { EditTool } from "@sid-code/core/tool/edit.ts";
import { WriteTool } from "@sid-code/core/tool/write.ts";
import { checkMemoryConclusionReplace } from "@sid-code/core/memory/write-guard.ts";
import {
  findConclusionReplacement,
  leadingConclusion,
  hasOverturnMarker,
} from "@sid-code/core/memory/conclusion-guard.ts";
import { getAutoMemPath } from "@sid-code/core/memory/paths.ts";
import { INDEX_TRUNCATION_NOTICE } from "@sid-code/core/memory/index-budget.ts";

let tmpHome: string;
let prevConfigDir: string | undefined;
let tmpProject: string;
let projDir: string;
let globalDir: string;
/** edit / write 那条路径用的记忆目录：由 `process.cwd()` 派生，与工具内的判据同源 */
let toolMemDir: string;

const OLD_BODY =
  "旧主题陈述：所有文档改动都必须走 PR 流程。\nWhy: 保持可回滚。\nHow to apply: 每次改动都开 PR。";
const NEW_BODY = "新主题陈述：文档改完直接推到 main 就行。\nWhy: 省事。\nHow to apply: 直接推。";

/** 一个含 frontmatter 的完整记忆文件内容 */
function memoryFileText(name: string, body: string): string {
  return [
    "---",
    `name: ${name}`,
    // description 刻意不复用正文首行：那样 edit 用例的 old_string 会命中两处
    // （frontmatter 一处 + 正文一处），测到的就不是闸门而是「多处匹配」报错。
    `description: 关于 ${name} 的一条记忆`,
    "type: project",
    "source: user_explicit",
    "created: 1700000000000",
    "updated: 1700000000000",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/** 把 MEMORY.md 写成「已截断」——闸门的触发前提 */
function markIndexTruncated(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "MEMORY.md"),
    `# 记忆索引\n\n- [topic](project_topic.md) — 旧主题\n${INDEX_TRUNCATION_NOTICE}`,
  );
}

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-mem-concl-home-"));
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
  tmpProject = mkdtempSync(join(tmpdir(), "sid-mem-concl-"));
  projDir = join(tmpProject, "mem-project");
  globalDir = join(tmpProject, "mem-global");
  clearMemorySummaryCache();
  // 让 getAutoMemPath 落到 tmpHome 下（SID_CONFIG_DIR 已指过去），测试结束整体删除
  toolMemDir = getAutoMemPath(process.cwd());
});

afterEach(() => {
  try {
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(join(tmpHome, "projects"), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeStore(): MemoryStore {
  return new MemoryStore(tmpProject, { projectMemoryDir: projDir, globalMemoryDir: globalDir });
}

// ─── T-M5a / T-M5b：save_memory 路径 ────────────────────────────

describe("T-M5a：索引已满时，save_memory 的同 key 结论级替换被拒", () => {
  async function seed(tool: MemoryTool): Promise<string> {
    const first = await tool.execute({
      key: "topic",
      value: OLD_BODY,
      type: "project",
      source: "user_explicit",
    });
    expect(first.isError).toBeFalsy();
    const file = join(projDir, "project_topic.md");
    expect(existsSync(file)).toBe(true);
    // store.set 会重写索引，所以「索引已满」必须**建完之后**才标上
    markIndexTruncated(projDir);
    return file;
  }

  test("换掉首行结论且无推翻标记 → isError，磁盘逐字未变", async () => {
    const tool = new MemoryTool(makeStore());
    const file = await seed(tool);
    const before = readFileSync(file, "utf8");

    const blocked = await tool.execute({ key: "topic", value: NEW_BODY, type: "project" });
    expect(blocked.isError).toBe(true);
    // 回告里必须给出旧结论原文 + 两种合法写法，否则模型只能猜
    expect(blocked.output).toContain("旧主题陈述");
    expect(blocked.output).toContain("推翻");
    expect(blocked.output).toContain("纠正");
    // 判据必须落在磁盘上：只回 isError 但写进去了，等于没拦
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("「更新：」不算声明 → 仍被拒", async () => {
    const tool = new MemoryTool(makeStore());
    await seed(tool);
    const blocked = await tool.execute({
      key: "topic",
      // 「更新：」与「追加」同义，放行等于把所有普通更新都放过
      value: `更新：${NEW_BODY}`,
      type: "project",
    });
    expect(blocked.isError).toBe(true);
  });

  test("「补充：」同样不算声明 → 仍被拒", async () => {
    const tool = new MemoryTool(makeStore());
    await seed(tool);
    const blocked = await tool.execute({
      key: "topic",
      value: `补充：${NEW_BODY}`,
      type: "project",
    });
    expect(blocked.isError).toBe(true);
  });
});

// ─── T-M5c：放行面（闸门不是恒关） ─────────────────────────────

describe("T-M5c：放行面", () => {
  test("带 `推翻：<理由>` → 放行", async () => {
    const tool = new MemoryTool(makeStore());
    const first = await tool.execute({ key: "topic", value: OLD_BODY, type: "project" });
    expect(first.isError).toBeFalsy();
    markIndexTruncated(projDir);

    const ok = await tool.execute({
      key: "topic",
      value: `推翻：旧流程已被 2026-11-14 的新约定取代。\n${NEW_BODY}`,
      type: "project",
    });
    expect(ok.isError).toBeFalsy();
    expect(readFileSync(join(projDir, "project_topic.md"), "utf8")).toContain("推翻");
  });

  test("带 `纠正：<新结论>` → 放行", async () => {
    const tool = new MemoryTool(makeStore());
    await tool.execute({ key: "topic", value: OLD_BODY, type: "project" });
    markIndexTruncated(projDir);

    const ok = await tool.execute({
      key: "topic",
      value: `纠正：文档改完直接推 main。\n${NEW_BODY}`,
      type: "project",
    });
    expect(ok.isError).toBeFalsy();
  });

  test("保留旧首行结论的细节级更新 → 放行（这是正常迭代，不该收紧）", async () => {
    const tool = new MemoryTool(makeStore());
    await tool.execute({ key: "topic", value: OLD_BODY, type: "project" });
    markIndexTruncated(projDir);

    const ok = await tool.execute({
      key: "topic",
      value: `${OLD_BODY.split("\n")[0]}\nWhy: 保持可回滚 + 便于 review。\nHow to apply: 每次改动都开 PR，合并前跑门禁。`,
      type: "project",
    });
    expect(ok.isError).toBeFalsy();
  });

  test("索引**未**满时同样场景放行（回归保护：正常迭代记忆不该被收紧）", async () => {
    const tool = new MemoryTool(makeStore());
    await tool.execute({ key: "topic", value: OLD_BODY, type: "project" });
    // 刻意不标截断
    const ok = await tool.execute({ key: "topic", value: NEW_BODY, type: "project" });
    expect(ok.isError).toBeFalsy();
    expect(readFileSync(join(projDir, "project_topic.md"), "utf8")).toContain("新主题陈述");
  });

  test("新建 key 不受这条闸门影响（索引满时该由 checkIndexFull 那条管）", async () => {
    const tool = new MemoryTool(makeStore());
    await tool.execute({ key: "topic", value: OLD_BODY, type: "project" });
    markIndexTruncated(projDir);

    const ok = await tool.execute({
      key: "another-topic",
      value: "另一件事的陈述：发布前必须跑一遍全量测试。Why: 防回归。How to apply: 每次发布前。",
      type: "project",
    });
    expect(ok.isError).toBeFalsy();
  });

  test("旧条目没有可判定主题陈述（首行就是 Why:）→ 放行", async () => {
    const tool = new MemoryTool(makeStore());
    await tool.execute({
      key: "topic",
      value: "Why: 没有主题陈述的旧条目。\nHow to apply: 任意。",
      type: "project",
    });
    markIndexTruncated(projDir);
    const ok = await tool.execute({ key: "topic", value: NEW_BODY, type: "project" });
    expect(ok.isError).toBeFalsy();
  });
});

// ─── T-M5b：edit / write 路径（判据不能只落一条路） ─────────────

describe("T-M5b：edit / write 覆盖已有记忆文件同样被拒", () => {
  function seedToolMemory(): string {
    mkdirSync(toolMemDir, { recursive: true });
    const file = join(toolMemDir, "topic.md");
    writeFileSync(file, memoryFileText("topic", OLD_BODY));
    markIndexTruncated(toolMemDir);
    return file;
  }

  test("edit 换掉首行结论 → isError，磁盘未变", async () => {
    const file = seedToolMemory();
    const before = readFileSync(file, "utf8");

    const res = await new EditTool().execute({
      file_path: file,
      old_string: "旧主题陈述：所有文档改动都必须走 PR 流程。",
      new_string: "新主题陈述：文档改完直接推到 main 就行。",
    });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("推翻");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("edit 追加细节（保留首行结论）→ 放行", async () => {
    const file = seedToolMemory();
    const res = await new EditTool().execute({
      file_path: file,
      old_string: "How to apply: 每次改动都开 PR。",
      new_string: "How to apply: 每次改动都开 PR，合并前跑门禁。",
    });
    expect(res.isError).toBeFalsy();
  });

  test("write 覆盖整份文件、丢掉旧首行结论 → isError，磁盘未变", async () => {
    const file = seedToolMemory();
    const before = readFileSync(file, "utf8");

    const res = await new WriteTool().execute({
      file_path: file,
      content: memoryFileText("topic", NEW_BODY),
    });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("纠正");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("write 带 `推翻：` → 放行", async () => {
    const file = seedToolMemory();
    const res = await new WriteTool().execute({
      file_path: file,
      content: memoryFileText("topic", `推翻：旧流程作废。\n${NEW_BODY}`),
    });
    expect(res.isError).toBeFalsy();
  });

  test("索引未满时 edit 同样放行（回归保护）", async () => {
    mkdirSync(toolMemDir, { recursive: true });
    const file = join(toolMemDir, "topic.md");
    writeFileSync(file, memoryFileText("topic", OLD_BODY));
    // 不标截断

    const res = await new EditTool().execute({
      file_path: file,
      old_string: "旧主题陈述：所有文档改动都必须走 PR 流程。",
      new_string: "新主题陈述：文档改完直接推到 main 就行。",
    });
    expect(res.isError).toBeFalsy();
  });

  test("非记忆路径不干预（闸门不做全局内容审查）", async () => {
    const file = join(tmpProject, "notes.md");
    writeFileSync(file, memoryFileText("notes", OLD_BODY));
    expect(
      checkMemoryConclusionReplace(file, memoryFileText("notes", NEW_BODY), tmpProject),
    ).toBeNull();
  });

  test("新建记忆文件不判（没有旧结论可替换）", () => {
    const file = join(toolMemDir, "brand-new.md");
    mkdirSync(toolMemDir, { recursive: true });
    markIndexTruncated(toolMemDir);
    expect(checkMemoryConclusionReplace(file, memoryFileText("brand-new", NEW_BODY))).toBeNull();
  });
});

// ─── 纯函数边界（不落盘） ──────────────────────────────────────

describe("conclusion-guard 纯函数边界", () => {
  test("leadingConclusion 取 Why: 之前那句，且只取首行", () => {
    expect(leadingConclusion("主题陈述。Why: 理由。How to apply: 做法。")).toBe("主题陈述");
    expect(leadingConclusion("主题陈述。\nWhy: 理由。")).toBe("主题陈述");
    expect(leadingConclusion("**Why:** 只有理由")).toBe("");
    expect(leadingConclusion("")).toBe("");
    expect(leadingConclusion("\n\n  第一行有效  \n第二行")).toBe("第一行有效");
  });

  test("hasOverturnMarker：行首标签且冒号后有内容才算", () => {
    expect(hasOverturnMarker("推翻：旧结论不成立")).toBe(true);
    expect(hasOverturnMarker("纠正: 新结论")).toBe(true);
    // 允许先跟一个 key（P0-4 教给模型的写法）
    expect(hasOverturnMarker("推翻 no-move-doc：这次不适用")).toBe(true);
    // 行文里的自然用词不算（与 referencesNegation 同一口径）
    expect(hasOverturnMarker("这不是推翻：而是常规流程")).toBe(false);
    // 空标签 = 没说明理由
    expect(hasOverturnMarker("推翻：")).toBe(false);
    // 「更新：」「补充：」刻意不在表里
    expect(hasOverturnMarker("更新：换了主题")).toBe(false);
  });

  test("findConclusionReplacement：旧结论还在 → 放行（归一化忽略空白与标点）", () => {
    const old = "用户要求：所有文档改动都必须走 PR 流程。";
    // 换行 + 全角/半角标点差异不应影响判定
    expect(
      findConclusionReplacement(old, "用户要求: 所有文档改动都必须走 PR 流程\nWhy: x"),
    ).toBeNull();
    expect(findConclusionReplacement(old, "别的一件事：直接推 main。")).not.toBeNull();
  });

  test("主题陈述过短 → 不判定（短串在任何新内容里都能被包含，会让闸门恒开）", () => {
    expect(findConclusionReplacement("短。Why: 理由", "完全不同的内容")).toBeNull();
  });
});
