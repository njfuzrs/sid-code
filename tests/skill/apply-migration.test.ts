/**
 * claude-code-migration 确定性写入脚本测试（apply-migration.mjs）
 *
 * 回归重点（2026-07 迁移 skill 崩溃复盘）：错误 1（模型即兴写 .mjs 用 require 崩）与
 * 错误 2（模型把 JSON 当 write.content 字符串被拒）的共同根因，是 skill 逼模型即兴写脚本
 * 做 JSON 合并。此脚本把"确定性 JSON 变换"从模型手里收回。测试覆盖：
 *   - patch 式合并只新增缺失键、不覆盖已有键（保住 availableModels[].apiKey 等嵌套字段）
 *   - 命名条目级冲突（mcpServers.<name>）逐条判定
 *   - MCP type->transport、disabled->enabled、丢弃不支持字段
 *   - --on-conflict overwrite 显式覆盖
 *   - --dry-run 不落盘
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(
  import.meta.dir,
  "../../src/skill/builtin/claude-code-migration/scripts/apply-migration.mjs",
);

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-mig-"));
});
afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 用 bun 跑脚本（sid-code 基于 bun，运行时一定在），返回解析后的 stdout JSON */
async function run(args: string[]): Promise<any> {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`脚本输出非 JSON: ${out}`);
  }
}

function writeJson(name: string, value: unknown): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
  return p;
}
function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

describe("apply-migration merge-settings", () => {
  test("只新增缺失顶层键，不覆盖已有键，保住嵌套 apiKey", async () => {
    const target = writeJson("settings.json", {
      model: "glm-5.2",
      availableModels: [{ id: "glm", apiKey: "secret-xyz" }],
    });
    const res = await run([
      "--op", "merge-settings",
      "--target", target,
      "--patch", JSON.stringify({ fallbackModel: "ali-deepseek", model: "other" }),
    ]);
    expect(res.ok).toBe(true);
    expect(res.added).toContain("fallbackModel");
    expect(res.conflicts).toContain("model"); // 已存在 → 冲突跳过

    const after = readJson(target);
    expect(after.fallbackModel).toBe("ali-deepseek");
    expect(after.model).toBe("glm-5.2"); // 未被覆盖
    // 关键：整体没被 Zod round-trip，嵌套 apiKey 原样保留
    expect(after.availableModels[0].apiKey).toBe("secret-xyz");
  });

  test("命名条目级合并：mcpServers.<name> 逐条判冲突", async () => {
    const target = writeJson("settings.json", {
      mcpServers: { old: { transport: "stdio" } },
    });
    const res = await run([
      "--op", "merge-settings",
      "--target", target,
      "--patch", JSON.stringify({ mcpServers: { new: { transport: "http" }, old: { transport: "ws" } } }),
    ]);
    expect(res.added).toContain("mcpServers.new");
    expect(res.conflicts).toContain("mcpServers.old");

    const after = readJson(target);
    expect(after.mcpServers.old.transport).toBe("stdio"); // 未被覆盖
    expect(after.mcpServers.new.transport).toBe("http");
  });

  test("--on-conflict overwrite 显式覆盖已有键", async () => {
    const target = writeJson("settings.json", { model: "glm-5.2" });
    await run([
      "--op", "merge-settings",
      "--target", target,
      "--patch", JSON.stringify({ model: "other" }),
      "--on-conflict", "overwrite",
    ]);
    expect(readJson(target).model).toBe("other");
  });

  test("目标不存在时创建新文件", async () => {
    const target = path.join(tmpDir, "sub/settings.json");
    const res = await run([
      "--op", "merge-settings",
      "--target", target,
      "--patch", JSON.stringify({ model: "glm-5.2" }),
    ]);
    expect(res.written).toBe(true);
    expect(readJson(target).model).toBe("glm-5.2");
  });
});

describe("apply-migration merge-mcp", () => {
  test("type->transport、disabled->enabled、丢弃不支持字段", async () => {
    const target = path.join(tmpDir, ".mcp.json");
    const res = await run([
      "--op", "merge-mcp",
      "--target", target,
      "--servers", JSON.stringify({
        "vibe-coding": { type: "http", url: "https://x", disabled: false, cwd: "/tmp", trust: true },
      }),
    ]);
    expect(res.ok).toBe(true);
    expect(res.added).toContain("vibe-coding");

    const s = readJson(target).mcpServers["vibe-coding"];
    expect(s.transport).toBe("http");
    expect(s.enabled).toBe(true); // disabled:false -> enabled:true
    expect(s.url).toBe("https://x");
    expect(s.cwd).toBeUndefined(); // 不支持字段被丢弃
    expect(s.trust).toBeUndefined();
  });

  test("command 无 type 时推导 stdio", async () => {
    const target = path.join(tmpDir, ".mcp.json");
    await run([
      "--op", "merge-mcp",
      "--target", target,
      "--servers", JSON.stringify({ local: { command: "node", args: ["x.js"] } }),
    ]);
    const s = readJson(target).mcpServers.local;
    expect(s.transport).toBe("stdio");
    expect(s.args).toEqual(["x.js"]);
  });

  test("已存在的 server 名算冲突，默认跳过、不覆盖", async () => {
    const target = writeJson(".mcp.json", { mcpServers: { existing: { transport: "stdio", command: "foo" } } });
    const res = await run([
      "--op", "merge-mcp",
      "--target", target,
      "--servers", JSON.stringify({ existing: { command: "bar" } }),
    ]);
    expect(res.conflicts).toContain("existing");
    expect(readJson(target).mcpServers.existing.command).toBe("foo"); // 未被覆盖
  });

  test("--dry-run 不落盘", async () => {
    const target = path.join(tmpDir, ".mcp.json");
    const res = await run([
      "--op", "merge-mcp",
      "--target", target,
      "--servers", JSON.stringify({ x: { command: "y" } }),
      "--dry-run",
    ]);
    expect(res.written).toBe(false);
    expect(res.result.mcpServers.x.transport).toBe("stdio"); // 预览里有转换结果
    expect(fs.existsSync(target)).toBe(false); // 但没落盘
  });
});

describe("apply-migration 错误处理", () => {
  test("非法 JSON patch → ok:false 且不写文件", async () => {
    const target = path.join(tmpDir, "settings.json");
    const res = await run([
      "--op", "merge-settings",
      "--target", target,
      "--patch", "{not json",
    ]);
    expect(res.ok).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });
});
