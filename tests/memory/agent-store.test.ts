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
    const { saveAgentMemory, getAgentIndexContent } = await import("@sid-code/core/memory/agent-store.ts");
    await saveAgentMemory("code-review", "prefer-early-return", "本仓偏好提前 return，避免深层嵌套");

    const idx = await getAgentIndexContent("code-review");
    expect(idx).not.toBeNull();
    expect(idx).toContain("prefer-early-return");
    expect(idx).toContain("# Memory Index");
  });

  test("写入落到 ~/.sid-code/memory/agents/<type>/ 且含 .md 记忆文件", async () => {
    const { saveAgentMemory } = await import("@sid-code/core/memory/agent-store.ts");
    await saveAgentMemory("security-audit", "check-ssrf", "外呼 URL 必须校验 SSRF");

    const dir = join(tmpHome, "memory", "agents", "security-audit");
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir);
    expect(files).toContain("MEMORY.md");
    // 至少一个记忆条目 .md（非索引）
    expect(files.some((f) => f.endsWith(".md") && f !== "MEMORY.md")).toBe(true);
  });

  test("buildAgentMemoryInjection 注入片段带 system-reminder 包装", async () => {
    const { saveAgentMemory, buildAgentMemoryInjection } = await import("@sid-code/core/memory/agent-store.ts");
    await saveAgentMemory("code-review", "k1", "v1");

    const injection = await buildAgentMemoryInjection("code-review");
    expect(injection).toContain("<system-reminder>");
    expect(injection).toContain("code-review");
    expect(injection).toContain("k1");
  });

  test("同 key 覆盖写入不产生重复条目", async () => {
    const { saveAgentMemory, getAgentIndexContent } = await import("@sid-code/core/memory/agent-store.ts");
    await saveAgentMemory("code-review", "dup", "第一版");
    await saveAgentMemory("code-review", "dup", "第二版内容");

    const idx = await getAgentIndexContent("code-review");
    const matches = (idx ?? "").split("\n").filter((l) => l.includes("[dup]"));
    expect(matches.length).toBe(1);
  });

  test("无记忆的 agent 类型读回 null（行为不变）", async () => {
    const { getAgentIndexContent } = await import("@sid-code/core/memory/agent-store.ts");
    const idx = await getAgentIndexContent("never-written");
    expect(idx).toBeNull();
  });
});

/**
 * 2026-07-30 回归：agent scope 索引的可寻址性
 *
 * 与私有/团队记忆同源的两个缺陷（详见 docs/_template/多任务报错.txt 排查）：
 * - 索引只给裸文件名、注入文案不给目录 → 子代理只能猜路径然后 Read 失败。
 *   这里比主会话更严重：目录是 `~/.sid-code/memory/agents/<sanitizeAgentType(type)>/`，
 *   slug 经过变换，子代理无法从 agentType 反推。
 * - key 混进类型前缀 → 索引方括号自带一个可能与文件真实分类矛盾的分类词。
 */
describe("agent 记忆索引可寻址性（2026-07-30 回归）", () => {
  test("索引带绝对目录，且「目录 + 链接文件名」能解析到真实文件", async () => {
    const { saveAgentMemory, getAgentIndexContent } = await import("@sid-code/core/memory/agent-store.ts");
    const { getAgentMemPath } = await import("@sid-code/core/memory/paths.ts");
    await saveAgentMemory("code-review", "prefer-early-return", "偏好提前 return");

    const idx = (await getAgentIndexContent("code-review"))!;
    const dir = getAgentMemPath("code-review");
    expect(idx).toContain(dir);

    const link = idx.match(/\]\(([^)]+)\)/)?.[1];
    expect(link).toBeDefined();
    expect(existsSync(join(dir, link!))).toBe(true);
  });

  test("注入文案指明用「目录 + 链接文件名」拼路径，并警告不要用 key", async () => {
    const { saveAgentMemory, buildAgentMemoryInjection } = await import("@sid-code/core/memory/agent-store.ts");
    await saveAgentMemory("code-review", "prefer-early-return", "偏好提前 return");

    const section = await buildAgentMemoryInjection("code-review");
    expect(section).toContain("绝对路径");
    expect(section).toContain("不要拿 key 拼路径");
  });

  test("key 自带类型前缀时不产生双前缀文件名，索引 key 也已归一化", async () => {
    const { saveAgentMemory, getAgentIndexContent } = await import("@sid-code/core/memory/agent-store.ts");
    const { getAgentMemPath } = await import("@sid-code/core/memory/paths.ts");
    await saveAgentMemory("code-review", "project_review-gotcha", "评审坑位");

    const dir = getAgentMemPath("code-review");
    const entries = readdirSync(dir).filter((f) => f !== "MEMORY.md");
    // 文件名不含双前缀
    expect(entries.some((f) => /^(user|feedback|project|reference)_(user|feedback|project|reference)[_-]/.test(f))).toBe(false);

    const idx = (await getAgentIndexContent("code-review"))!;
    // 方括号里的 key 不再残留类型前缀
    const keys = [...idx.matchAll(/- \[([^\]]+)\]/g)].map((m) => m[1]!);
    expect(keys.every((k) => !/^(user|feedback|project|reference)[_-]/.test(k))).toBe(true);
    expect(keys).toContain("review-gotcha");
  });

  test("无记忆时仍返回空串（不注入空段）", async () => {
    const { buildAgentMemoryInjection } = await import("@sid-code/core/memory/agent-store.ts");
    expect(await buildAgentMemoryInjection("never-used")).toBe("");
  });
});
