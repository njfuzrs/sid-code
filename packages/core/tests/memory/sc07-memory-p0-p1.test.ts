/**
 * 记忆系统 P0/P1 修复门禁（顺着 sc-07-memory 核出的缺陷，2026-09-26 文档）
 *
 * 每条 describe 对应文档里一个缺陷编号。断言都挑「修复前会红」的信号：
 * 缺陷 1 的管道 / -exec / 命令替换；缺陷 3 的「dream 写空后清单仍列出」；
 * 缺陷 5 的「压缩后 tokenGrowth 为负」；缺陷 9 的子目录与 201 条。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Message } from "@sid-code/core/llm/types.ts";
import type { PermissionResult } from "@sid-code/core/tool/types.ts";
import {
  createExtractPermissions,
  createSessionMemoryPermissions,
  isReadonlyBash,
} from "@sid-code/core/memory/extract/permissions.ts";
import {
  findRelevantMemories,
  formatRecentTools,
  truncateRecallBody,
  type SideQueryFn,
} from "@sid-code/core/memory/recall.ts";
import { MEMORY_LIMITS } from "@sid-code/core/memory/types.ts";
import { reconcileMemoryDir } from "@sid-code/core/memory/dream/dream.ts";
import { scanMemoryFiles } from "@sid-code/core/memory/scan.ts";
import {
  shouldExtractSessionMemory,
  initialSessionMemoryState,
  estimateMessagesTokens,
} from "@sid-code/core/session-memory/utils.ts";
import {
  rebuildTeamIndex,
  getTeamIndexContent,
  listTeamMemoryFiles,
} from "@sid-code/core/memory/team/store.ts";
import { getTeamMemPath } from "@sid-code/core/memory/team/paths.ts";
import { classifyMemoryReadPath, getAutoMemPath } from "@sid-code/core/memory/paths.ts";
import { utf8Bytes } from "@sid-code/core/memory/index-budget.ts";

function behaviorOf(r: PermissionResult | Promise<PermissionResult>): string {
  return (r as PermissionResult).behavior;
}

let tmp: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sid-sc07-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = join(tmp, "config");
});
afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(tmp, { recursive: true, force: true });
});

function mem(dir: string, file: string, name: string, body: string) {
  const p = join(dir, file);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, `---\nname: ${name}\ndescription: ${name} 描述\ntype: project\n---\n\n${body}`);
  return p;
}

// ─── 缺陷 1（P0）───────────────────────────────────────────────
describe("缺陷 1：后台记忆代理 bash 只读判定逐命令校验", () => {
  const allow = ["ls -la", "cat a | grep b | wc -l", "find . -name '*.md'", "head f && tail g"];
  const deny = [
    "cat /etc/passwd | sh",
    "grep x file | bash",
    "cat a; sh",
    "find . -exec sh -c 'id' \\;",
    "find . -delete",
    "cat <(sh -c id)",
    "echo $(id)",
    "ls `id`",
    "echo hi > file",
    "rm -rf /",
    "",
  ];
  for (const c of allow) {
    test(`放行: ${c}`, () => expect(isReadonlyBash({ command: c })).toBe(true));
  }
  for (const c of deny) {
    test(`拒绝: ${JSON.stringify(c)}`, () => expect(isReadonlyBash({ command: c })).toBe(false));
  }
  test("三个代理都走同一判定（提取 / dream 复用提取 / 会话笔记）", () => {
    const ex = createExtractPermissions(tmp);
    const sm = createSessionMemoryPermissions(join(tmp, "s.md"));
    expect(behaviorOf(ex("bash", { command: "cat x | sh" }))).toBe("deny");
    expect(behaviorOf(sm("bash", { command: "cat x | sh" }))).toBe("deny");
    expect(behaviorOf(ex("bash", { command: "ls" }))).toBe("allow");
    expect(behaviorOf(sm("bash", { command: "ls" }))).toBe("allow");
  });
});

// ─── 缺陷 2 + 4（P1）──────────────────────────────────────────
describe("缺陷 2：recentTools 真的进了选择器输入", () => {
  test("formatRecentTools：失败优先于成功", () => {
    const s = formatRecentTools([
      { name: "bash", failed: false },
      { name: "bash", failed: true },
      { name: "read", failed: false },
    ]);
    expect(s).toContain("最近成功使用的工具: read");
    expect(s).toContain("最近失败的工具: bash");
    expect(s).not.toMatch(/成功使用的工具:.*bash/);
    expect(formatRecentTools([])).toBe("");
  });

  test("findRelevantMemories 把 recentTools 传给 sideQuery", async () => {
    mem(tmp, "a.md", "a", "正文");
    let seenUser = "";
    let seenSystem = "";
    const sq: SideQueryFn = async ({ user, system }) => {
      seenUser = user;
      seenSystem = system;
      return `{"selected":[]}`;
    };
    await findRelevantMemories("q", tmp, sq, {
      recentTools: [{ name: "grep", failed: true }],
    });
    expect(seenUser).toContain("最近失败的工具: grep");
    expect(seenSystem).toContain("最近成功使用的工具");
  });
});

describe("缺陷 4：召回三层预算", () => {
  test("单文件按行截断到 RECALL_FILE_MAX_BYTES 以内，并指回原文件", () => {
    const body = Array.from({ length: 2000 }, (_, i) => `第 ${i} 行中文内容`).join("\n");
    const out = truncateRecallBody(body, MEMORY_LIMITS.RECALL_FILE_MAX_BYTES, "/x/a.md");
    expect(utf8Bytes(out)).toBeLessThanOrEqual(MEMORY_LIMITS.RECALL_FILE_MAX_BYTES);
    expect(out).toContain("Read /x/a.md");
    // 行边界：截断前的最后一行必须完整
    const kept = out.split("\n\n…")[0].split("\n");
    expect(kept[kept.length - 1]).toMatch(/^第 \d+ 行中文内容$/);
  });

  test("findRelevantMemories 注入的单条正文被截断", async () => {
    mem(tmp, "big.md", "big", "x".repeat(20_000));
    const sq: SideQueryFn = async () => `{"selected":["big.md"]}`;
    const r = await findRelevantMemories("q", tmp, sq);
    expect(r.length).toBe(1);
    expect(utf8Bytes(r[0].content)).toBeLessThan(MEMORY_LIMITS.RECALL_FILE_MAX_BYTES + 512);
  });

  test("会话累计预算用完即停，且不发 sideQuery", async () => {
    mem(tmp, "a.md", "a", "正文");
    let called = 0;
    const sq: SideQueryFn = async () => {
      called++;
      return `{"selected":["a.md"]}`;
    };
    const r = await findRelevantMemories("q", tmp, sq, {
      sessionBytesUsed: MEMORY_LIMITS.RECALL_SESSION_MAX_BYTES,
    });
    expect(r).toEqual([]);
    expect(called).toBe(0);
  });

  test("剩余预算放不下就停在那一条", async () => {
    mem(tmp, "a.md", "a", "y".repeat(3000));
    mem(tmp, "b.md", "b", "z".repeat(3000));
    const sq: SideQueryFn = async () => `{"selected":["a.md","b.md"]}`;
    const r = await findRelevantMemories("q", tmp, sq, {
      sessionBytesUsed: MEMORY_LIMITS.RECALL_SESSION_MAX_BYTES - 4000,
    });
    expect(r.map((m) => m.filename)).toEqual(["a.md"]);
  });

  test("app.ts 压缩 / clear 路径重置召回状态（静态接线门禁）", async () => {
    const src = await Bun.file(join(import.meta.dir, "../../../cli/src/app.ts")).text();
    // 5 处：两处 /clear、/compact 命令、autoCompact、reactive/collapse
    expect(src.match(/this\.resetRecallState\(\);/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(src).toContain("recentTools: this.collectRecentToolUses()");
    expect(src).toContain("sessionBytesUsed: this.recalledMemoryBytes");
  });
});

// ─── 缺陷 3（P1）──────────────────────────────────────────────
describe("缺陷 3：dream 写空后当场归档并重建索引", () => {
  test("reconcileMemoryDir：空文件进 archive/、清单不再列出、索引不含它", async () => {
    mem(tmp, "keep.md", "keep", "保留");
    const dead = mem(tmp, "dead.md", "dead", "将被删");
    // 模拟 dream 的 write 写空（只剩 frontmatter）
    writeFileSync(dead, `---\nname: dead\ndescription: d\ntype: project\n---\n`);
    expect((await scanMemoryFiles(tmp)).map((h) => h.filename)).toContain("dead.md");

    await reconcileMemoryDir(tmp);

    expect(existsSync(dead)).toBe(false);
    expect(existsSync(join(tmp, "archive", "dead.md"))).toBe(true);
    const names = (await scanMemoryFiles(tmp)).map((h) => h.filename);
    expect(names).toContain("keep.md");
    expect(names).not.toContain("dead.md");
    const index = readFileSync(join(tmp, "MEMORY.md"), "utf8");
    expect(index).toContain("keep.md");
    expect(index).not.toContain("dead.md");
  });

  test("dream.ts 的 finally 调用了 reconcileMemoryDir（接线门禁）", async () => {
    const src = await Bun.file(join(import.meta.dir, "../../src/memory/dream/dream.ts")).text();
    const fin = src.slice(src.indexOf("} finally {"));
    expect(fin.slice(0, 600)).toContain("await reconcileMemoryDir(ctx.memoryDir)");
  });
});

// ─── 缺陷 5（P1）──────────────────────────────────────────────
describe("缺陷 5：压缩后会话笔记门闩基线跟着落下", () => {
  const config = {
    minimumMessageTokensToInit: 100,
    minimumTokensBetweenUpdate: 50,
    toolCallsBetweenUpdates: 3,
  };
  const user = (t: string): Message => ({ role: "user", content: [{ type: "text", text: t }] });
  const asst = (t: string): Message => ({
    role: "assistant",
    content: [{ type: "text", text: t }],
  });

  test("token 骤降后再增长超过阈值即可触发（修复前 tokenGrowth 为负，永不触发）", () => {
    const before = [user("x".repeat(40_000)), asst("ok")];
    const state = {
      ...initialSessionMemoryState(),
      initialized: true,
      lastSummarizedTokenCount: estimateMessagesTokens(before),
    };
    // 压缩：消息被替换成一小段摘要
    const afterCompact = [user("摘要")];
    expect(shouldExtractSessionMemory(state, afterCompact, config)).toBe(false);
    expect(state.lastSummarizedTokenCount).toBe(estimateMessagesTokens(afterCompact));
    // 压缩后会话继续增长 ≥ 阈值
    const grown = [...afterCompact, user("y".repeat(2000)), asst("done")];
    expect(shouldExtractSessionMemory(state, grown, config)).toBe(true);
  });
});

// ─── 缺陷 9（P1）──────────────────────────────────────────────
describe("缺陷 9：团队记忆索引递归 + 预算 + 年龄", () => {
  const cwd = "/tmp/sid-sc07-team-project";

  test("子目录文件进索引；点文件、冲突副本、archive/ 不进", async () => {
    const dir = getTeamMemPath(cwd);
    mkdirSync(dir, { recursive: true });
    mem(dir, "top.md", "top", "t");
    mem(dir, "sub/nested.md", "nested", "n");
    mem(dir, "x.conflict-123.md", "c", "c");
    mem(dir, ".hidden.md", "h", "h");
    mem(dir, "archive/old.md", "old", "o");
    expect((await listTeamMemoryFiles(dir)).sort()).toEqual(["sub/nested.md", "top.md"]);
    await rebuildTeamIndex(dir);
    const idx = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(idx).toContain("(sub/nested.md)");
    expect(idx).toContain("(top.md)");
    // 冲突副本不作为记忆条目进索引；缺陷 8 起它只出现在「未裁决冲突」段
    expect(idx).not.toContain("](x.conflict-");
    expect(idx).toContain("未裁决的团队记忆冲突（1）");
    expect(idx).toContain("# 团队共享记忆");
  });

  test("超过 200 条截断并告警，字节不超 25KB", async () => {
    const dir = getTeamMemPath(cwd);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 210; i++) mem(dir, `m${String(i).padStart(3, "0")}.md`, `m${i}`, "b");
    await rebuildTeamIndex(dir);
    const idx = readFileSync(join(dir, "MEMORY.md"), "utf8");
    const entries = idx.split("\n").filter((l) => l.startsWith("- ["));
    expect(entries.length).toBe(MEMORY_LIMITS.INDEX_MAX_ENTRIES);
    expect(idx).toContain("索引已截断");
    expect(utf8Bytes(idx)).toBeLessThanOrEqual(MEMORY_LIMITS.INDEX_MAX_BYTES);
  });

  test("注入时补年龄标注", async () => {
    const dir = getTeamMemPath(cwd);
    mkdirSync(dir, { recursive: true });
    const p = mem(dir, "aged.md", "aged", "a");
    const old = (Date.now() - 10 * 86_400_000) / 1000;
    const { utimesSync } = await import("fs");
    utimesSync(p, old, old);
    await rebuildTeamIndex(dir);
    const content = await getTeamIndexContent(cwd);
    expect(content).toContain("⏳");
  });
});

// ─── 缺陷 10（P1）─────────────────────────────────────────────
describe("缺陷 10：Read 记忆文件有分子埋点", () => {
  const cwd = "/tmp/sid-sc07-read-project";

  test("classifyMemoryReadPath 分出四条线与索引", () => {
    const home = process.env.SID_CONFIG_DIR!;
    expect(classifyMemoryReadPath(join(getAutoMemPath(cwd), "a.md"), cwd)).toEqual({
      scope: "project",
      isIndex: false,
    });
    expect(classifyMemoryReadPath(join(getAutoMemPath(cwd), "MEMORY.md"), cwd)).toEqual({
      scope: "project",
      isIndex: true,
    });
    expect(classifyMemoryReadPath(join(getTeamMemPath(cwd), "t.md"), cwd)?.scope).toBe("team");
    expect(classifyMemoryReadPath(join(home, "memory", "g.md"), cwd)?.scope).toBe("global");
    expect(classifyMemoryReadPath(join(home, "memory", "agents", "x", "a.md"), cwd)?.scope).toBe(
      "agent",
    );
    expect(classifyMemoryReadPath("/etc/hosts", cwd)).toBeNull();
    expect(classifyMemoryReadPath(join(home, "settings.json"), cwd)).toBeNull();
  });

  test("read.ts 成功路径调用 logMemoryRead（接线门禁）", async () => {
    const src = await Bun.file(join(import.meta.dir, "../../src/tool/read.ts")).text();
    const okIdx = src.indexOf("✓ 读取 ${filePath}");
    const tail = src.slice(okIdx, okIdx + 1200);
    expect(tail).toContain("classifyMemoryReadPath(filePath)");
    expect(tail).toContain("logMemoryRead(hit)");
  });
});
