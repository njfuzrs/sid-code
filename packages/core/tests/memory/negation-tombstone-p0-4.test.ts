/**
 * P0-4（MD7）：用户否定后没有 tombstone，下一轮可能原样写回
 *
 * ## 缺陷背景
 *
 * 用户说「不要 X」之后，记忆库里没有任何**结构化的**否定记录。下一轮（或下一个会话）
 * 的后台提取代理只看得到「X 是流程」那条记忆，看不到「用户不要 X」——
 * 于是它照旧写回，甚至把用户这次的「没反对」当成默认同意。
 *
 * ## 本文件钉住的判据
 *
 * 判据是**结构的，不是语义的**（中文语义等价无法用字符串判定，见方案文档 P0-4
 * 的「判据的诚实说明」）：
 *
 * - **T-M7**：存在否定记录（`negates` 指向 key `K`）时，往 `K` 的写入若没有显式引用
 *   该否定记录 → 被拒，且**磁盘上没有写入**。
 * - **T-M7b**：显式引用（写出否定记录的 key，或行首 `例外：<理由>`）→ 放行。
 *   守的是「闸门不是恒关」——恒关的闸门会被绕过，且会让人以为防住了。
 * - **T-M7c（不误伤）**：无否定记录时同 key 写入照常；写其它 key 不受影响；
 *   更新否定记录自身不被自己挡住。
 * - **T-M7d**：`negates` 落盘 + 归一化 + 清单可见（判据的结构地基）。
 *
 * ## 覆盖边界（诚实说明）
 *
 * 本判据只覆盖 `save_memory` 路径。后台提取代理的另一条主要写入方式是 `edit`
 * 直接改写记忆文件（方案文档 D16），那条路径的闸门属于 P1-1 的覆盖范围。
 * 不要在这个测试文件里假装它已经被挡住。
 *
 * ## 隔离
 *
 * 落盘目标全部指向 tmpdir：`MemoryStore` 显式传 `projectMemoryDir` / `globalMemoryDir`，
 * 并额外设 `SID_CONFIG_DIR` 兜住任何未传覆盖参数的路径。env 存/恢复原值，不无条件 delete。
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MemoryStore, clearMemorySummaryCache } from "@sid-code/core/memory/store.ts";
import { MemoryTool, findUnreferencedNegation } from "@sid-code/core/tool/memory.ts";
import { referencesNegation } from "@sid-code/core/memory/types.ts";
import { scanMemoryFiles, formatMemoryManifest } from "@sid-code/core/memory/scan.ts";

let tmpProject: string;
let projDir: string;
let globalDir: string;
let tmpHome: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-mem-neg-home-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
});

afterAll(() => {
  // 存/恢复原值，不无条件 delete —— bun test 同批多文件跑在同一进程里，
  // delete 会把 preload 的兜底一起抹掉。
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  tmpProject = mkdtempSync(join(tmpdir(), "sid-mem-neg-"));
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

/** 读某条记忆文件（不存在返回 null，便于断言「根本没落盘」） */
function readMemoryFile(filename: string): string | null {
  const p = join(projDir, filename);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** 项目记忆目录下所有 .md 文件名（不含索引） */
function listMemoryFiles(): string[] {
  if (!existsSync(projDir)) return [];
  return readdirSync(projDir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
}

/**
 * 先建一条「做法」记忆，再建一条否定它的 tombstone。
 *
 * 两个步骤都用主会话路径（不带 `_querySource`）：feedback 的用户原话闸门
 * 只拦后台提取路径（P0-2），主会话写入不受它约束，本文件测的是 P0-4。
 */
async function seedNegatedPair(tool: MemoryTool): Promise<void> {
  const flow = await tool.execute({
    key: "proactive-move-doc",
    value:
      "修完文档就把 bug 修复文档移到 done 目录。Why: 保持目录整洁。How to apply: 每次修完都移。",
    type: "project",
    source: "user_explicit",
  });
  expect(flow.isError).toBeFalsy();

  const tomb = await tool.execute({
    key: "no-proactive-move-doc",
    value:
      "用户说「以后别自己把我的文档移到 done」。Why: 用户要自己决定何时收尾。How to apply: 修完只报告，不动文档目录。生效日期 2026-11-14。",
    type: "feedback",
    source: "user_explicit",
    negates: "proactive-move-doc",
  });
  expect(tomb.isError).toBeFalsy();
}

// ─── T-M7：未引用否定记录的写入被拒 ─────────────────────────────

describe("T-M7：存在否定记录时，往被否定的 key 回写未引用 → 被拒", () => {
  test("未引用 → isError，且磁盘上没有被改写", async () => {
    const store = makeStore();
    const tool = new MemoryTool(store);
    await seedNegatedPair(tool);

    const before = readMemoryFile("project_proactive-move-doc.md");
    expect(before).not.toBeNull();

    const blocked = await tool.execute({
      key: "proactive-move-doc",
      value: "修完文档后移入 done 目录是既定流程。Why: 保持整洁。How to apply: 每次都移。",
      type: "project",
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain("no-proactive-move-doc");
    expect(blocked.output).toContain("例外");

    // 判据必须落在磁盘上：只回 isError 但写进去了，等于没拦。
    expect(readMemoryFile("project_proactive-move-doc.md")).toBe(before);
  });

  test("正文只用自然用词「这不是例外：……」不算显式声明 → 仍被拒", async () => {
    const store = makeStore();
    const tool = new MemoryTool(store);
    await seedNegatedPair(tool);

    const blocked = await tool.execute({
      key: "proactive-move-doc",
      // 行文中出现「例外」，但不是行首标签、也没有说明理由
      value: "这不是例外：而是常规流程。Why: 保持一致。How to apply: 每次都移。",
      type: "project",
    });
    expect(blocked.isError).toBe(true);
  });

  test("建立否定记录本身的写入不被自己挡住", async () => {
    const store = makeStore();
    const tool = new MemoryTool(store);
    // 建完再更新一次 tombstone 正文（仍带 negates）
    await seedNegatedPair(tool);
    const again = await tool.execute({
      key: "no-proactive-move-doc",
      value:
        "用户说「以后别自己把我的文档移到 done」。Why: 用户自己决定何时收尾。How to apply: 只报告，不动目录。生效日期 2026-11-14。",
      type: "feedback",
      negates: "proactive-move-doc",
    });
    expect(again.isError).toBeFalsy();
  });
});

// ─── T-M7b：显式引用后放行 ─────────────────────────────────────

describe("T-M7b：显式引用否定记录 → 放行", () => {
  test("正文写出否定记录的 key → 放行", async () => {
    const store = makeStore();
    const tool = new MemoryTool(store);
    await seedNegatedPair(tool);

    const ok = await tool.execute({
      key: "proactive-move-doc",
      value:
        "推翻 no-proactive-move-doc：用户 2026-11-14 明确说这次这个仓库的文档由我收尾。" +
        "Why: 用户当场授权。How to apply: 只在这个仓库、且用户当次明确要求时移文档。",
      type: "project",
      source: "user_explicit",
    });
    expect(ok.isError).toBeFalsy();
    const after = readMemoryFile("project_proactive-move-doc.md");
    expect(after).toContain("推翻 no-proactive-move-doc");
  });

  test("行首「例外：<理由>」→ 放行", async () => {
    const store = makeStore();
    const tool = new MemoryTool(store);
    await seedNegatedPair(tool);

    const ok = await tool.execute({
      key: "proactive-move-doc",
      value:
        "例外：用户 2026-11-14 在这台机器上明确要求把文档归档。" +
        "Why: 一次性授权。How to apply: 只做这一次。",
      type: "project",
    });
    expect(ok.isError).toBeFalsy();
  });
});

// ─── T-M7c：不误伤 ────────────────────────────────────────────

describe("T-M7c：无否定记录 / 无关 key 不受影响", () => {
  test("没有任何否定记录时，同 key 更新照常放行", async () => {
    const store = makeStore();
    const tool = new MemoryTool(store);
    await tool.execute({
      key: "coding-style",
      value: "两空格缩进。Why: 与仓库一致。How to apply: 所有新代码。",
      type: "project",
    });
    const ok = await tool.execute({
      key: "coding-style",
      value: "两空格缩进，LF 换行。Why: 与仓库一致。How to apply: 所有新代码。",
      type: "project",
    });
    expect(ok.isError).toBeFalsy();
  });

  test("存在否定记录时，写**其它** key 不受影响", async () => {
    const store = makeStore();
    const tool = new MemoryTool(store);
    await seedNegatedPair(tool);

    const ok = await tool.execute({
      key: "unrelated-note",
      value:
        "这个仓库用 bun 不用 npm。Why: 发行产物是单文件二进制。How to apply: 跑测试用 bun test。",
      type: "project",
    });
    expect(ok.isError).toBeFalsy();
  });
});

// ─── T-M7d：negates 落盘 / 归一化 / 清单可见 ────────────────────

describe("T-M7d：negates 的结构地基", () => {
  test("否定记录落盘 frontmatter 带 negates；普通记忆不带", async () => {
    const store = makeStore();
    const tool = new MemoryTool(store);
    await seedNegatedPair(tool);

    const tomb = readMemoryFile("feedback_no-proactive-move-doc.md");
    expect(tomb).toContain("negates: proactive-move-doc");
    expect(tomb).toContain("source: user_explicit");

    const plain = readMemoryFile("project_proactive-move-doc.md");
    expect(plain).not.toBeNull();
    expect(plain).not.toContain("negates:");
  });

  test("negates 归一化：传 feedback_x / x.md 都能命中同一个 key", async () => {
    const store = makeStore();
    const tool = new MemoryTool(store);
    await seedNegatedPair(tool);

    // tombstone 的 negates 落盘后是裸 key，两种带前缀的写法都应命中它
    for (const alias of ["project_proactive-move-doc", "proactive-move-doc.md"]) {
      const blocked = await tool.execute({
        key: alias,
        value: "修完文档就移入 done。Why: 干净。How to apply: 每次都移。",
        type: "project",
      });
      expect(blocked.isError).toBe(true);
    }
  });

  test("清单里能看到 negates，普通条目看不到", async () => {
    const store = makeStore();
    const tool = new MemoryTool(store);
    await seedNegatedPair(tool);

    const headers = await scanMemoryFiles(projDir);
    const manifest = formatMemoryManifest(headers);
    expect(manifest).toContain("negates: proactive-move-doc");

    const tombHeader = headers.find((h) => h.name === "no-proactive-move-doc");
    expect(tombHeader?.negates).toBe("proactive-move-doc");
    const plainHeader = headers.find((h) => h.name === "proactive-move-doc");
    expect(plainHeader?.negates).toBeNull();
  });

  test("不带 negates 的普通更新不会把否定记录抹成普通记忆", async () => {
    const store = makeStore();
    // 直接走 store：模拟 /memory set 这类不带 negates 的更新路径
    await store.set(
      "no-proactive-move-doc",
      "用户说「代码以后每次提交前都跑一遍 lint」。Why: 曾因 lint 失败返工。How to apply: 提交前跑。生效日期 2026-11-14。",
      "project",
      { type: "feedback", source: "user_explicit", negates: "proactive-move-doc" },
    );
    await store.set(
      "no-proactive-move-doc",
      "用户说「代码以后每次提交前都跑一遍 lint」。Why: 曾因 lint 失败返工。How to apply: 提交前跑，别跳过。生效日期 2026-11-14。",
      "project",
      { type: "feedback" },
    );
    const entries = await store.list();
    const tomb = entries.find((e) => e.key === "no-proactive-move-doc");
    expect(tomb?.negates).toBe("proactive-move-doc");
  });

  test("negates 只允许 feedback 类型", async () => {
    const store = makeStore();
    const tool = new MemoryTool(store);
    const bad = await tool.execute({
      key: "some-project-note",
      value: "随便一条项目记忆。Why: 测试。How to apply: 无。",
      type: "project",
      negates: "x",
    });
    expect(bad.isError).toBe(true);
    expect(bad.output).toContain("feedback");
    expect(listMemoryFiles()).toHaveLength(0);
  });
});

// ─── 纯函数边界（不落盘） ────────────────────────────────────

describe("findUnreferencedNegation / referencesNegation 的边界", () => {
  const entries = [
    { key: "no-move-doc", value: "用户说「别移文档」", negates: "move-doc" },
    { key: "plain", value: "普通记忆" },
  ];

  test("命中的是 negates 指向的 key，而不是否定记录自己的 key", () => {
    expect(findUnreferencedNegation(entries, "move-doc", "再写一遍")?.tombstoneKey).toBe(
      "no-move-doc",
    );
    // 更新否定记录自己：不该被它自己挡住
    expect(findUnreferencedNegation(entries, "no-move-doc", "改一下措辞")).toBeNull();
    // 无关 key
    expect(findUnreferencedNegation(entries, "plain", "改一下")).toBeNull();
  });

  test("显式引用 negates 的目标 key 也算引用", () => {
    // 写出被否定的目标 key（move-doc）同样能定位到这条否定记录
    expect(findUnreferencedNegation(entries, "move-doc", "这次例外：move-doc 允许")).toBeNull();
  });

  test("referencesNegation：行首标签 + 理由才算，行文用词不算", () => {
    expect(referencesNegation("例外：用户当次授权", "no-x", "x")).toBe(true);
    expect(referencesNegation("推翻：旧结论不成立", "no-x", "x")).toBe(true);
    expect(referencesNegation("这不是例外：而是常规", "no-x", "x")).toBe(false);
    // 标签后面没内容 = 没说明理由
    expect(referencesNegation("例外：", "no-x", "x")).toBe(false);
    // 引用 key 时按词边界匹配，不做子串误命中
    expect(referencesNegation("随便提一句 xyz", "no-x", "x")).toBe(false);
  });
});
