/**
 * G13 落地回归测试：agent scope 记忆写入端
 *
 * 守护「写→读→注入」闭环：saveAgentMemory 写盘后，getAgentIndexContent /
 * buildAgentMemoryInjection 能立即读到，且写入书式（frontmatter + MEMORY.md 索引）正确。
 * 此前只有读取端就绪、写入端缺失（目录永不被填充），本测试确保生产端真正打通。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmpHome: string;
let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-agentmem-"));
  process.env.SID_CONFIG_DIR = tmpHome;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevEnv;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("G13 — saveAgentMemory 写入端", () => {
  test("写入后能立即读回索引内容", async () => {
    const { saveAgentMemory, getAgentIndexContent } = await import("../../src/memory/agent-store.ts");
    await saveAgentMemory("code-review", "prefer-early-return", "本仓偏好提前 return，避免深层嵌套");

    const idx = await getAgentIndexContent("code-review");
    expect(idx).not.toBeNull();
    expect(idx).toContain("prefer-early-return");
    expect(idx).toContain("# Memory Index");
  });

  test("写入落到 ~/.sid-code/memory/agents/<type>/ 且含 .md 记忆文件", async () => {
    const { saveAgentMemory } = await import("../../src/memory/agent-store.ts");
    await saveAgentMemory("security-audit", "check-ssrf", "外呼 URL 必须校验 SSRF");

    const dir = join(tmpHome, "memory", "agents", "security-audit");
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir);
    expect(files).toContain("MEMORY.md");
    // 至少一个记忆条目 .md（非索引）
    expect(files.some((f) => f.endsWith(".md") && f !== "MEMORY.md")).toBe(true);
  });

  test("buildAgentMemoryInjection 注入片段带 system-reminder 包装", async () => {
    const { saveAgentMemory, buildAgentMemoryInjection } = await import("../../src/memory/agent-store.ts");
    await saveAgentMemory("code-review", "k1", "v1");

    const injection = await buildAgentMemoryInjection("code-review");
    expect(injection).toContain("<system-reminder>");
    expect(injection).toContain("code-review");
    expect(injection).toContain("k1");
  });

  test("同 key 覆盖写入不产生重复条目", async () => {
    const { saveAgentMemory, getAgentIndexContent } = await import("../../src/memory/agent-store.ts");
    await saveAgentMemory("code-review", "dup", "第一版");
    await saveAgentMemory("code-review", "dup", "第二版内容");

    const idx = await getAgentIndexContent("code-review");
    const matches = (idx ?? "").split("\n").filter((l) => l.includes("[dup]"));
    expect(matches.length).toBe(1);
  });

  test("无记忆的 agent 类型读回 null（行为不变）", async () => {
    const { getAgentIndexContent } = await import("../../src/memory/agent-store.ts");
    const idx = await getAgentIndexContent("never-written");
    expect(idx).toBeNull();
  });
});
