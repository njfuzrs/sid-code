/**
 * 团队记忆写入器测试（E.11）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { saveTeamMemory, getTeamIndexContent } from "@sid-code/core/memory/team/store.ts";
import { getTeamMemPath } from "@sid-code/core/memory/team/paths.ts";
import { _resetWatcherStateForTesting } from "@sid-code/core/memory/team/watcher.ts";

let tmpRoot: string;
let prevConfigDir: string | undefined;
const cwd = "/tmp/sid-team-store-project";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sid-teamstore-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = join(tmpRoot, "config");
  _resetWatcherStateForTesting(); // watcher 未启动，notify 应静默
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("saveTeamMemory", () => {
  test("写入 .md 文件并重建 MEMORY.md 索引", async () => {
    const r = await saveTeamMemory("pr_title_rule", "PR 标题不超过 70 字符", {
      type: "feedback",
      description: "PR 标题规范",
      cwd,
    });
    expect(r.success).toBe(true);
    expect(existsSync(r.filePath!)).toBe(true);

    const content = readFileSync(r.filePath!, "utf8");
    expect(content).toContain("name: pr_title_rule");
    expect(content).toContain("type: feedback");
    expect(content).toContain("PR 标题不超过 70 字符");

    // 索引重建
    const indexPath = join(getTeamMemPath(cwd), "MEMORY.md");
    expect(existsSync(indexPath)).toBe(true);
    const index = readFileSync(indexPath, "utf8");
    expect(index).toContain("pr_title_rule");
    expect(index).toContain("PR 标题规范");
  });

  test("含 secret 的记忆被拒绝写入", async () => {
    const r = await saveTeamMemory("leak", "token: ghp_" + "z".repeat(36), { cwd });
    expect(r.success).toBe(false);
    expect(r.rejectedSecret).toBe(true);
    expect(r.error).toContain("secret");
    // 错误不含明文
    expect(r.error).not.toContain("z".repeat(36));
    // 目录里不应出现该记忆文件
    const dir = getTeamMemPath(cwd);
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => f.includes("leak"));
      expect(files.length).toBe(0);
    }
  });

  test("未指定 type 时启发式推断", async () => {
    const r = await saveTeamMemory("api_doc", "参考 https://example.com/api 文档", { cwd });
    expect(r.success).toBe(true);
    const content = readFileSync(r.filePath!, "utf8");
    // 含 URL → reference
    expect(content).toContain("type: reference");
  });
});

describe("getTeamIndexContent（E.11 索引注入）", () => {
  test("目录无索引时返回 null", async () => {
    expect(await getTeamIndexContent(cwd)).toBeNull();
  });

  test("写入记忆后能读回团队索引内容", async () => {
    await saveTeamMemory("pr_rule", "PR 标题不超过 70 字符", {
      type: "feedback",
      description: "PR 标题规范",
      cwd,
    });
    const index = await getTeamIndexContent(cwd);
    expect(index).not.toBeNull();
    expect(index).toContain("pr_rule");
    expect(index).toContain("PR 标题规范");
  });
});
