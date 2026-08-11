/**
 * 团队记忆同步引擎测试（E.11）
 *
 * 隔离策略：
 *   - SID_CONFIG_DIR 指向临时目录 → 控制本地团队记忆目录位置。
 *   - teamMemory.dir 指向另一临时目录 → 充当共享「远端」。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { syncTeamMemory, hashContent } from "@sid-code/core/memory/team/sync.ts";
import { getTeamMemPath } from "@sid-code/core/memory/team/paths.ts";

let tmpRoot: string;
let configDir: string;
let sharedDir: string;
let prevConfigDir: string | undefined;
const cwd = "/tmp/sid-team-test-project"; // 固定 cwd，避免 git toplevel 干扰

function localDir(): string {
  return getTeamMemPath(cwd);
}

function writeLocal(name: string, content: string): void {
  const dir = localDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

function writeShared(name: string, content: string): void {
  if (!existsSync(sharedDir)) mkdirSync(sharedDir, { recursive: true });
  writeFileSync(join(sharedDir, name), content);
}

function opts() {
  return { enabled: true, dir: sharedDir };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sid-teamsync-"));
  configDir = join(tmpRoot, "config");
  sharedDir = join(tmpRoot, "shared");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(sharedDir, { recursive: true });
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("syncTeamMemory — 早退保护", () => {
  test("未启用返回 disabled", async () => {
    const r = await syncTeamMemory({ enabled: false }, cwd);
    expect(r.success).toBe(false);
    expect(r.errorType).toBe("disabled");
  });

  test("无共享目录返回 no_shared_dir", async () => {
    const r = await syncTeamMemory({ enabled: true }, cwd);
    expect(r.success).toBe(false);
    expect(r.errorType).toBe("no_shared_dir");
  });
});

describe("syncTeamMemory — 基础推拉", () => {
  test("仅本地有 → push 到共享", async () => {
    writeLocal("a.md", "团队约定 A");
    const r = await syncTeamMemory(opts(), cwd);
    expect(r.success).toBe(true);
    expect(r.pushed).toBe(1);
    expect(readFileSync(join(sharedDir, "a.md"), "utf8")).toBe("团队约定 A");
  });

  test("仅共享有 → pull 到本地", async () => {
    writeShared("b.md", "团队约定 B");
    const r = await syncTeamMemory(opts(), cwd);
    expect(r.success).toBe(true);
    expect(r.pulled).toBe(1);
    expect(readFileSync(join(localDir(), "b.md"), "utf8")).toBe("团队约定 B");
  });

  test("两端一致 → 不推不拉", async () => {
    writeLocal("c.md", "same");
    writeShared("c.md", "same");
    const r = await syncTeamMemory(opts(), cwd);
    expect(r.success).toBe(true);
    expect(r.pushed).toBe(0);
    expect(r.pulled).toBe(0);
  });

  test("MEMORY.md 索引与隐藏文件不参与同步", async () => {
    writeLocal("MEMORY.md", "# index");
    writeLocal(".hidden.md", "x");
    const r = await syncTeamMemory(opts(), cwd);
    expect(r.pushed).toBe(0);
    expect(existsSync(join(sharedDir, "MEMORY.md"))).toBe(false);
  });
});

describe("syncTeamMemory — 删除传播", () => {
  test("本地删除（已同步过）→ 删除共享", async () => {
    // 第一次同步：建立 base
    writeLocal("d.md", "v1");
    await syncTeamMemory(opts(), cwd);
    expect(existsSync(join(sharedDir, "d.md"))).toBe(true);
    // 本地删除后再同步
    rmSync(join(localDir(), "d.md"));
    const r = await syncTeamMemory(opts(), cwd);
    expect(r.deleted).toBe(1);
    expect(existsSync(join(sharedDir, "d.md"))).toBe(false);
  });

  test("共享删除（已同步过）→ 删除本地", async () => {
    writeShared("e.md", "v1");
    await syncTeamMemory(opts(), cwd);
    expect(existsSync(join(localDir(), "e.md"))).toBe(true);
    rmSync(join(sharedDir, "e.md"));
    const r = await syncTeamMemory(opts(), cwd);
    expect(r.deleted).toBe(1);
    expect(existsSync(join(localDir(), "e.md"))).toBe(false);
  });
});

describe("syncTeamMemory — 冲突解析", () => {
  test("双方都改且不同 → mtime 新者获胜，旧版另存 .conflict 副本", async () => {
    // 建立 base
    writeLocal("f.md", "base");
    await syncTeamMemory(opts(), cwd);

    // 两端各自改成不同内容；让本地 mtime 更新
    writeShared("f.md", "shared-change");
    await new Promise((res) => setTimeout(res, 20));
    writeLocal("f.md", "local-change");

    const r = await syncTeamMemory(opts(), cwd);
    expect(r.conflicts).toBe(1);
    // 本地较新 → 本地胜
    expect(readFileSync(join(sharedDir, "f.md"), "utf8")).toBe("local-change");
    // 共享旧版应另存为 conflict 副本（两端都有）
    const localFiles = require("fs").readdirSync(localDir()) as string[];
    expect(localFiles.some((n) => n.includes(".conflict-"))).toBe(true);
  });

  test("一侧删除 + 另一侧改动 → 复活改动方", async () => {
    writeLocal("g.md", "base");
    await syncTeamMemory(opts(), cwd);
    // 本地删除，共享改动
    rmSync(join(localDir(), "g.md"));
    writeShared("g.md", "shared-edit");
    const r = await syncTeamMemory(opts(), cwd);
    expect(r.conflicts).toBe(1);
    // 改动优先于删除 → 复活到本地
    expect(existsSync(join(localDir(), "g.md"))).toBe(true);
    expect(readFileSync(join(localDir(), "g.md"), "utf8")).toBe("shared-edit");
  });
});

describe("syncTeamMemory — secret 守卫", () => {
  test("含 secret 的本地文件跳过 push（不外泄到共享）", async () => {
    writeLocal("leak.md", "token: ghp_" + "a".repeat(36));
    writeLocal("clean.md", "干净内容");
    const r = await syncTeamMemory(opts(), cwd);
    expect(r.skippedSecrets.length).toBe(1);
    expect(r.skippedSecrets[0].path).toBe("leak.md");
    expect(r.skippedSecrets[0].ruleId).toBe("github-pat");
    // 含 secret 的文件没进共享目录
    expect(existsSync(join(sharedDir, "leak.md"))).toBe(false);
    // 干净文件正常同步
    expect(existsSync(join(sharedDir, "clean.md"))).toBe(true);
    // skippedSecrets 不含明文
    expect(JSON.stringify(r.skippedSecrets)).not.toContain("a".repeat(36));
  });
});

describe("syncTeamMemory — pull 后重建本地 MEMORY.md 索引（审计第 17 条）", () => {
  // 这组补的是原测试盲区：旧测试只断言「MEMORY.md 不被 push 到共享目录」（契约前半句），
  // 从未断言「pull 后本地索引被重建」（后半句）。缺后半句时同步下来的条目躺在磁盘上，
  // 而注入侧 getTeamIndexContent 只读索引文件、无扫目录 fallback → 团队记忆对模型不可见。

  function entry(name: string, desc: string, body: string): string {
    return `---\nname: ${name}\ndescription: ${desc}\ntype: project\n---\n\n${body}\n`;
  }

  test("全新端 pull → 索引被建出且含同事条目", async () => {
    writeShared("project_deploy-flow.md", entry("deploy-flow", "发布走 release.sh", "正文"));
    const r = await syncTeamMemory(opts(), cwd);
    expect(r.pulled).toBe(1);

    const index = readFileSync(join(localDir(), "MEMORY.md"), "utf8");
    expect(index).toContain("deploy-flow");
    expect(index).toContain("发布走 release.sh");
    expect(index).toContain("project_deploy-flow.md");
  });

  test("老端已有自己的索引 → pull 后索引含两端条目（不再只见自己那条）", async () => {
    writeLocal("project_mine.md", entry("mine", "我自己的约定", "正文"));
    writeLocal("MEMORY.md", "# 团队共享记忆\n\n- [mine](project_mine.md) — 我自己的约定\n");
    writeShared("project_theirs.md", entry("theirs", "同事的约定", "正文"));

    const r = await syncTeamMemory(opts(), cwd);
    expect(r.pulled).toBe(1);

    const index = readFileSync(join(localDir(), "MEMORY.md"), "utf8");
    expect(index).toContain("theirs");
    expect(index).toContain("mine"); // 自己那条不能被抹掉
  });

  test("删除传播后索引不留悬空指针", async () => {
    writeShared("project_rule-one.md", entry("rule-one", "规则一", "正文"));
    await syncTeamMemory(opts(), cwd);
    expect(readFileSync(join(localDir(), "MEMORY.md"), "utf8")).toContain("project_rule-one.md");

    rmSync(join(sharedDir, "project_rule-one.md"));
    const r = await syncTeamMemory(opts(), cwd);
    expect(r.deleted).toBe(1);
    expect(existsSync(join(localDir(), "project_rule-one.md"))).toBe(false);
    // 索引不能再指向已删除的文件（否则模型照索引 Read 必然失败）
    expect(readFileSync(join(localDir(), "MEMORY.md"), "utf8")).not.toContain("project_rule-one.md");
  });

  test("索引重建后的内容可被注入侧 getTeamIndexContent 读到", async () => {
    writeShared("project_x.md", entry("x-rule", "x 的说明", "正文"));
    await syncTeamMemory(opts(), cwd);

    const { getTeamIndexContent } = await import("@sid-code/core/memory/team/store.ts");
    const content = await getTeamIndexContent(cwd);
    expect(content).not.toBeNull();
    expect(content!).toContain("x-rule");
  });

  test("纯 push 轮次不重建索引（本地未变，避免无谓写盘触发 watcher）", async () => {
    writeLocal("project_only-local.md", entry("only-local", "只在本地", "正文"));
    const r = await syncTeamMemory(opts(), cwd);
    expect(r.pushed).toBe(1);
    expect(r.pulled).toBe(0);
    // 本地目录内容没被 sync 改动 → 索引维护是 saveTeamMemory 的职责，sync 不越权
    expect(existsSync(join(localDir(), "MEMORY.md"))).toBe(false);
  });

  test("索引不会把冲突副本列进去", async () => {
    writeLocal("h.md", "base");
    await syncTeamMemory(opts(), cwd);
    writeLocal("h.md", "local-change");
    await new Promise((res) => setTimeout(res, 20));
    writeShared("h.md", "shared-change"); // 共享较新 → 共享胜，本地旧版另存 conflict

    const r = await syncTeamMemory(opts(), cwd);
    expect(r.conflicts).toBe(1);
    const index = readFileSync(join(localDir(), "MEMORY.md"), "utf8");
    expect(index).not.toContain(".conflict-");
  });
});

describe("hashContent", () => {
  test("稳定且带 sha256: 前缀", () => {
    const h = hashContent("hello");
    expect(h.startsWith("sha256:")).toBe(true);
    expect(hashContent("hello")).toBe(h);
    expect(hashContent("world")).not.toBe(h);
  });
});
