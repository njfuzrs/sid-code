/**
 * S9 防复发：记忆 key 重名的两条产生路径 + 索引按类型优先级保留
 *
 * 缺陷背景（20261016 静默停住方案 §2 S9）：本仓真实记忆库 205 个 `.md` 里有 9 对重名 name。
 * - 路径 A：提取代理把文件名（`project_x`）当 key 传给 set ⇒ store 视作新 key 落出第二个文件，
 *   下一次 load 把 `name: project_x` 就地改写成 `x` ⇒ 同 name 两个文件。
 * - 路径 B：另一进程已写过同 key、本进程快照过期，`inferMemoryType` 推出另一前缀 ⇒ 第二个文件。
 *
 * 判据统一为「磁盘上重名 name 数 = 0」——读磁盘，不读 store API（API 是去重后的内存视角）。
 * 变异自证：回退 store.ts 的 resolveMemoryKey / 路径 B 探盘 / 改写前查占用，对应用例各自变红。
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MemoryStore, clearMemorySummaryCache } from "@sid-code/core/memory/store.ts";
import { formatMemoryManifest, scanMemoryFiles } from "@sid-code/core/memory/scan.ts";

let tmpProject: string;
let projDir: string;
let globalDir: string;
let tmpHome: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-mem-s9-home-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
});

afterAll(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  tmpProject = mkdtempSync(join(tmpdir(), "sid-mem-s9-"));
  projDir = join(tmpProject, "mem-project");
  globalDir = join(tmpProject, "mem-global");
  mkdirSync(projDir, { recursive: true });
  clearMemorySummaryCache();
});

afterEach(() => {
  rmSync(tmpProject, { recursive: true, force: true });
});

function newStore(): MemoryStore {
  return new MemoryStore(tmpProject, { projectMemoryDir: projDir, globalMemoryDir: globalDir });
}

/** 直接读磁盘统计 name，返回重名的 name 列表 */
function diskDupNames(dir: string): string[] {
  const count = new Map<string, number>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md") || f === "MEMORY.md") continue;
    const n = readFileSync(join(dir, f), "utf8")
      .match(/^name:\s*(.+)$/m)?.[1]
      ?.trim();
    if (n) count.set(n, (count.get(n) ?? 0) + 1);
  }
  return [...count].filter(([, c]) => c > 1).map(([n]) => n);
}

function writeMem(file: string, name: string, type: string, body: string, updated = 1) {
  writeFileSync(
    join(projDir, file),
    `---\nname: ${name}\ndescription: ${body}\ntype: ${type}\nupdated: ${updated}\n---\n\n${body}\n`,
  );
}

describe("S9 路径 A：文件名当 key", () => {
  test("set('project_x') 更新已有的 x，不落第二个文件；再 load 也不出重名", async () => {
    const s = newStore();
    await s.set("x", "v1", "project", { type: "project" });
    await s.set("project_x", "v2", "project", { type: "project" });
    const s2 = newStore();
    await s2.load();
    expect(diskDupNames(projDir)).toEqual([]);
    expect((await s2.get("x"))?.value).toBe("v2");
    expect(readdirSync(projDir).filter((f) => f !== "MEMORY.md")).toEqual(["project_x.md"]);
  });

  test("带 .md 后缀的文件名也能解析回 key", async () => {
    const s = newStore();
    await s.set("y", "v1", "project", { type: "feedback" });
    await s.set("feedback_y.md", "v2", "project");
    expect(diskDupNames(projDir)).toEqual([]);
    expect((await s.get("y"))?.value).toBe("v2");
  });

  test("合法前缀 key（user-auth）的 set/get/delete 不被剥成 auth", async () => {
    const s = newStore();
    await s.set("user-auth", "登录流程", "project", { type: "project" });
    expect((await s.get("user-auth"))?.key).toBe("user-auth");
    expect(await s.get("auth")).toBeNull();
    expect(await s.delete("user-auth")).toBe(true);
    expect(await s.get("user-auth")).toBeNull();
  });

  test("x 与 project_x 并存时 delete('project_x') 只删后者", async () => {
    // 两条都是合法 key（名字恰好带前缀的那条与另一条无关）——构造存量状态
    writeMem("project_x.md", "x", "project", "bare");
    writeMem("project_x-1.md", "project_x", "project", "prefixed");
    const s = newStore();
    expect(await s.delete("project_x")).toBe(true);
    expect((await s.get("x"))?.value).toContain("bare");
    const left = readdirSync(projDir).filter((f) => f !== "MEMORY.md");
    expect(left).toEqual(["project_x.md"]);
  });

  test("load 时剥前缀改写 name 前先查占用：撞了就保留原 name，不造重名", async () => {
    writeMem("project_x.md", "x", "project", "a");
    writeMem("project_x-1.md", "project_x", "project", "b");
    const s = newStore();
    await s.load();
    expect(diskDupNames(projDir)).toEqual([]);
    expect(readFileSync(join(projDir, "project_x-1.md"), "utf8")).toContain("name: project_x");
  });

  test("无冲突时剥前缀改写照常生效（不把修复做成全面禁用）", async () => {
    writeMem("project_z.md", "project_z", "project", "c");
    const s = newStore();
    await s.load();
    expect(readFileSync(join(projDir, "project_z.md"), "utf8")).toContain("name: z\n");
  });

  test("提取清单每行带 key: <frontmatter name>", async () => {
    writeMem("feedback_k.md", "k", "feedback", "desc");
    const manifest = formatMemoryManifest(await scanMemoryFiles(projDir));
    expect(manifest).toContain("key: k | filename: feedback_k.md");
  });
});

describe("S9 路径 B：跨进程过期快照 + 推断 type 不同", () => {
  test("另一进程已写 feedback_x.md（name: x），本进程无 type 的 set('x') 认领它而不新建", async () => {
    const s = newStore();
    await s.load(); // 快照此刻为空
    // 模拟另一进程直写盘：绕过模块级写入代数，本实例快照因此过期
    writeMem("feedback_w.md", "w", "feedback", "其它进程写的");
    await s.set("w", "本进程更新", "project");
    expect(diskDupNames(projDir)).toEqual([]);
    const files = readdirSync(projDir).filter((f) => f !== "MEMORY.md");
    expect(files).toEqual(["feedback_w.md"]);
    expect(readFileSync(join(projDir, "feedback_w.md"), "utf8")).toContain("type: feedback");
  });
});

describe("S9 索引按类型优先级保留", () => {
  test("字节预算截断时 user/feedback 优先于更新的 project/reference", async () => {
    const s = newStore();
    const long = "长摘要".repeat(60);
    // 先写 user/feedback（updatedAt 更旧），再灌大量 project 撑爆 25KB
    await s.set("u-pref", long, "project", { type: "user", description: long });
    await s.set("f-rule", long, "project", { type: "feedback", description: long });
    for (let i = 0; i < 150; i++) {
      await s.set(`p-${i}`, long, "project", { type: "project", description: long });
    }
    const idx = readFileSync(join(projDir, "MEMORY.md"), "utf8");
    expect(idx).toContain("索引已截断");
    expect(idx).toContain("[u-pref]");
    expect(idx).toContain("[f-rule]");
    // 组内仍按 updatedAt 倒序：最新的 project 在最旧的 project 之前
    expect(idx.indexOf("[p-149]")).toBeGreaterThan(-1);
    expect(idx.indexOf("[p-0]")).toBe(-1);
  });
});
