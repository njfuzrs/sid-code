/**
 * P0-3（MD6）：记忆来源（`source`）的落盘、强制覆写与索引可见性
 *
 * ## 缺陷背景
 *
 * 后台记忆提取代理把「agent 自己这一轮做了什么」写成记忆，落盘后与「用户明确说的偏好」
 * 在 `MEMORY.md` 索引里并列；索引全量注入 system prompt，下一个会话的模型把它当成
 * 「记忆里的事实」，按它行动、再把行动结果写回记忆，形成自我强化。
 *
 * ## 本文件钉住的三条判据
 *
 * - **T-M9**：`querySource === "memory-extract"` 时，模型传入的 `source=user_explicit`
 *   被 `tool.execute` **强制覆写**为 `agent_action`。守的是「不靠模型自觉」这个设计前提。
 *   断言必须落在 `execute` 的产物（磁盘 frontmatter）上 ——
 *   fork 执行器丢弃 `updatedInput`，在权限层做覆写会测得绿却写不进盘。
 * - **T-M6**：`agent_action` 的条目**不出现在** `MEMORY.md` 索引。
 * - **T-M4**：空清单 + 索引未满时新 key 可写（回归保护，防把容量闸做成恒拒）。
 *
 * ## 隔离
 *
 * 落盘目标全部指向 tmpdir：`MemoryStore` 显式传 `projectMemoryDir` / `globalMemoryDir`，
 * 并额外设 `SID_CONFIG_DIR` 兜住任何未传覆盖参数的路径（见 store.test.ts 头注释的
 * 2962 个真实家目录残留物证）。env 存/恢复原值，不无条件 delete。
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MemoryStore, clearMemorySummaryCache } from "@sid-code/core/memory/store.ts";
import { MemoryTool } from "@sid-code/core/tool/memory.ts";

let tmpProject: string;
let projDir: string;
let globalDir: string;
let tmpHome: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-mem-source-home-"));
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
  tmpProject = mkdtempSync(join(tmpdir(), "sid-mem-source-"));
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

/** 读项目范围的 MEMORY.md 索引（不存在时返回空串，便于断言「根本没落盘」） */
function readIndex(): string {
  const p = join(projDir, "MEMORY.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** 读某条记忆文件的完整内容（含 frontmatter） */
function readMemoryFile(type: string, key: string): string {
  return readFileSync(join(projDir, `${type}_${key}.md`), "utf8");
}

// ─── T-M9：后台提取路径的强制覆写 ───────────────────────────────

describe("T-M9：querySource=memory-extract 时 source 被 execute 强制覆写", () => {
  test("模型自称 user_explicit → 落盘 frontmatter 是 agent_action", async () => {
    const tool = new MemoryTool(makeStore());
    const res = await tool.execute({
      key: "pref",
      value: "用户偏好用 pnpm 管理依赖",
      type: "feedback",
      // 模型自称「这是用户明确说的」——但本次写入来自后台提取代理，它没有用户输入可依据
      source: "user_explicit",
      _querySource: "memory-extract",
    });
    expect(res.isError).toBeFalsy();

    const file = readMemoryFile("feedback", "pref");
    expect(file).toContain("source: agent_action");
    // 逐字断言「没有 user_explicit」：只说了「有 agent_action」不够，
    // 同一行被写两遍（`source: agent_action` + 残留 `source: user_explicit`）
    // 在 YAML 里后者覆盖前者，而 `toContain` 会放它过去。
    expect(file).not.toContain("user_explicit");
  });

  test("对照：主会话显式 user_explicit 如实落盘（覆写只对提取路径生效）", async () => {
    const tool = new MemoryTool(makeStore());
    const res = await tool.execute({
      key: "pref",
      value: "用户偏好用 pnpm 管理依赖",
      type: "feedback",
      source: "user_explicit",
      // 没有 _querySource ⇒ 主会话路径
    });
    expect(res.isError).toBeFalsy();
    expect(readMemoryFile("feedback", "pref")).toContain("source: user_explicit");
  });

  test("其它 fork（session-memory-update）不覆写：只有提取路径是那条没有用户依据的路径", async () => {
    const tool = new MemoryTool(makeStore());
    await tool.execute({
      key: "pref",
      value: "用户偏好用 pnpm 管理依赖",
      type: "feedback",
      source: "user_explicit",
      _querySource: "session-memory-update",
    });
    expect(readMemoryFile("feedback", "pref")).toContain("source: user_explicit");
  });

  test("提取路径不传 source 也落 agent_action（不因「没传」退回 inferred）", async () => {
    const tool = new MemoryTool(makeStore());
    await tool.execute({
      key: "flow",
      value: "改代码前先跑 affected-tests",
      type: "project",
      _querySource: "memory-extract",
    });
    expect(readMemoryFile("project", "flow")).toContain("source: agent_action");
  });
});

// ─── T-M6：agent_action 不进索引 ───────────────────────────────

describe("T-M6：agent_action 的条目不出现在 MEMORY.md", () => {
  test("混合写入时只有非 agent_action 的条目进索引", async () => {
    const store = makeStore();
    await store.set("agent-flow", "我改代码前先跑测试", "project", {
      type: "project",
      source: "agent_action",
    });
    await store.set("user-pref", "用户偏好 pnpm", "project", {
      type: "user",
      source: "user_explicit",
    });

    const index = readIndex();
    expect(index).toContain("user-pref");
    expect(index).not.toContain("agent-flow");
  });

  test("只有 agent_action 时索引文件不落盘（不留空表头残留）", async () => {
    const store = makeStore();
    await store.set("agent-flow", "我改代码前先跑测试", "project", {
      type: "project",
      source: "agent_action",
    });

    expect(existsSync(join(projDir, "MEMORY.md"))).toBe(false);
    // 但文件本身必须在：索引不可见 ≠ 删除，它仍可被显式 Read 捞回来
    expect(existsSync(join(projDir, "project_agent-flow.md"))).toBe(true);
  });

  test("load() 重建索引时同样过滤（入口不止 set()——提取代理直接改盘）", async () => {
    // 模拟提取代理绕过 set() 直接写盘：一条 agent_action 文件早已在目录里
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, "project_written-by-fork.md"),
      [
        "---",
        "name: written-by-fork",
        "description: 提取代理想固化的行为",
        "type: project",
        "source: agent_action",
        "created: 1",
        "updated: 1",
        "---",
        "",
        "我上次先跑了 build",
        "",
      ].join("\n"),
    );

    const store = makeStore();
    await store.load();
    // 再写一条普通记忆触发索引重建（load 后 set 会重写索引）
    await store.set("user-pref", "用户偏好 pnpm", "project", {
      type: "user",
      source: "user_explicit",
    });

    const index = readIndex();
    expect(index).toContain("user-pref");
    expect(index).not.toContain("written-by-fork");
  });
});

// ─── 缺省值与更新语义 ─────────────────────────────────────────

describe("source 的缺省值与更新语义", () => {
  test("未标 source 的新条目落盘 inferred（不假装来自用户）", async () => {
    await makeStore().set("k", "v", "project", { type: "project" });
    expect(readMemoryFile("project", "k")).toContain("source: inferred");
  });

  test("老文件（没有 source 行）解析为 inferred，且能正常进索引", async () => {
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, "user_legacy.md"),
      [
        "---",
        "name: legacy",
        "description: 老记忆没有 source 字段",
        "type: user",
        "created: 1",
        "updated: 1",
        "---",
        "",
        "用户偏好 pnpm",
        "",
      ].join("\n"),
    );

    const store = makeStore();
    await store.load();
    const entry = await store.get("legacy");
    expect(entry?.source).toBe("inferred");

    // 老记忆不该因为「没有 source 行」就被藏进不可见区
    await store.set("fresh", "v", "project", { type: "project" });
    expect(readIndex()).toContain("legacy");
  });

  test("不带 source 的更新不把 user_explicit 静默降级", async () => {
    const store = makeStore();
    await store.set("k", "v1", "project", { type: "user", source: "user_explicit" });
    // 普通正文更新（不打算改来源）
    await store.set("k", "v2", "project", { type: "user" });
    expect(readMemoryFile("user", "k")).toContain("source: user_explicit");
  });

  test("非法 source 值被忽略，落到缺省而不是猜一个", async () => {
    const tool = new MemoryTool(makeStore());
    await tool.execute({
      key: "k",
      value: "v",
      type: "project",
      source: "totally_made_up",
    });
    const file = readMemoryFile("project", "k");
    expect(file).toContain("source: inferred");
    expect(file).not.toContain("totally_made_up");
  });

  test("落盘-解析往返保持 source（新实例从磁盘读回）", async () => {
    await makeStore().set("k", "v", "project", { type: "project", source: "agent_action" });
    // 换一个实例并 load()：走的是 parseMemoryFile 的读盘路径，不是内存里那份
    const reopened = makeStore();
    await reopened.load();
    expect((await reopened.get("k"))?.source).toBe("agent_action");
  });
});

// ─── T-M4：容量闸的回归保护 ───────────────────────────────────

describe("T-M4：空清单 + 索引未满时新 key 可写（回归保护）", () => {
  test("空目录首次写入成功且落盘", async () => {
    const store = makeStore();
    const r = await store.set("first", "第一条记忆", "project", { type: "project" });

    expect(r.isNewKey).toBe(true);
    expect(existsSync(join(projDir, "project_first.md"))).toBe(true);
    expect(readIndex()).toContain("first");
  });
});
