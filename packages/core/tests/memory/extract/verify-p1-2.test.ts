/**
 * P1-2（MD5）：让提取代理周期性回头核实一条「很久没人读」的记忆
 *
 * ## 缺陷背景
 *
 * 记忆只写不校。一条记忆的前提可能早就变了（「这个仓库用 A 方案」→ 后来改成 B），
 * 而提取提示词明确写着「不要为确认旧记忆是否仍然准确去读代码」—— 它没有核实通道，
 * 于是过期记忆一直躺在索引里，每轮随 system prompt 注入，误导后续会话。
 *
 * ## 本文件钉住的判据
 *
 * - **选目标**：超过 `staleDays` 天没被读过的才选；`agent_action` 排除（它不进索引，
 *   模型看不见）；从未读过的优先于「读过但很久了」。
 * - **注意：**`new Date()` 依赖的 `now` 全部显式传入，不依赖机器当前时间。
 * - **频率**：每 `verifyEvery` 次提取一次；`0` = 关闭（显式关闭是合法意图）。
 * - **提示词二选一**：带核实目标时「不要验证」段被**替换**成核实段 —— 两段同时出现时
 *   模型会选保守那条（少做一件事不吃亏），核实就永远不会发生。这条是本文件里最容易被
 *   后人「顺手加回来」破坏的约束。
 * - **预算**：核实轮次 `maxTurns` 5 → 6（多出来那一轮就是核实成本）。
 *
 * ## 变异自证（本文件逐条确认过）
 *
 * - 把 `pickVerifyTarget` 的 `staleDays` 判据去掉 → 「未到天数不选」变红；
 * - 把 `agent_action` 的排除去掉 → 对应用例变红；
 * - 把 `shouldVerifyThisRound` 改成恒 `true` → 「every=0 关闭」与「只在第 N 次触发」变红；
 * - 把提示词改成「核实段 + 不要验证段并存」→ 二选一用例变红；
 * - 把 `maxTurns` 恒 5 → 预算用例变红。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pickVerifyTarget,
  resolveVerifyEvery,
  shouldVerifyThisRound,
  DEFAULT_STALE_DAYS,
  DEFAULT_VERIFY_EVERY,
} from "@sid-code/core/memory/extract/verify.ts";
import { buildExtractPrompt } from "@sid-code/core/memory/extract/prompts.ts";
import { initExtractMemories } from "@sid-code/core/memory/extract/extractor.ts";
import type { MemoryHeader } from "@sid-code/core/memory/types.ts";
import type { MemoryReadStat } from "@sid-code/core/memory/read-stats.ts";

const DAY = 86_400_000;
/** 固定「现在」，不依赖机器时间 —— 否则这些用例会在某天莫名开始失败 */
const NOW = 1_800_000_000_000;

let tmpHome: string;
let prevConfigDir: string | undefined;
let prevVerifyEvery: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-verify-p12-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  prevVerifyEvery = process.env.SID_CODE_MEMORY_VERIFY_EVERY;
  process.env.SID_CONFIG_DIR = tmpHome;
  delete process.env.SID_CODE_MEMORY_VERIFY_EVERY;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  if (prevVerifyEvery === undefined) delete process.env.SID_CODE_MEMORY_VERIFY_EVERY;
  else process.env.SID_CODE_MEMORY_VERIFY_EVERY = prevVerifyEvery;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function header(
  memDir: string,
  filename: string,
  opts: { mtimeMs: number; source?: MemoryHeader["source"]; name?: string },
): MemoryHeader {
  return {
    filename,
    filePath: join(memDir, filename),
    mtimeMs: opts.mtimeMs,
    description: "d",
    name: opts.name ?? filename.replace(/\.md$/, ""),
    type: "project",
    source: opts.source ?? "user_explicit",
    negates: null,
  };
}

// ─── 选目标 ─────────────────────────────────────────────────────

describe("pickVerifyTarget", () => {
  const memDir = "/tmp/does-not-matter";

  test("超过 staleDays 未读 → 选中；未到天数 → 不选", () => {
    const old = header(memDir, "project_old.md", { mtimeMs: NOW - 30 * DAY });
    const fresh = header(memDir, "project_fresh.md", { mtimeMs: NOW - 2 * DAY });
    const stats: Record<string, MemoryReadStat> = {
      "project_old.md": { lastRead: NOW - 30 * DAY, readCount: 1 },
      "project_fresh.md": { lastRead: NOW - 2 * DAY, readCount: 1 },
    };

    expect(pickVerifyTarget([old], stats, { memoryDir: memDir, now: NOW })?.key).toBe(
      "project_old",
    );
    // 一条都没到天数 → null（本轮正常提取，不硬塞核实任务）
    expect(pickVerifyTarget([fresh], stats, { memoryDir: memDir, now: NOW })).toBeNull();
  });

  test("从未被读过 → 按写入时间算年龄，且优先于读过的旧条目", () => {
    const neverRead = header(memDir, "feedback_never.md", { mtimeMs: NOW - 20 * DAY });
    const readLongAgo = header(memDir, "project_read.md", { mtimeMs: NOW - 60 * DAY });
    const stats: Record<string, MemoryReadStat> = {
      // 读过的那条闲置更久（60 天 vs 20 天），但从未读过的更可疑 —— 它一次都没被验证过
      "project_read.md": { lastRead: NOW - 60 * DAY, readCount: 3 },
    };

    const picked = pickVerifyTarget([readLongAgo, neverRead], stats, {
      memoryDir: memDir,
      now: NOW,
    });
    expect(picked?.key).toBe("feedback_never");
    expect(picked?.neverRead).toBe(true);
  });

  test("agent_action 不选（它不进索引，模型看不见，核实没人受益）", () => {
    const hidden = header(memDir, "project_hidden.md", {
      mtimeMs: NOW - 90 * DAY,
      source: "agent_action",
    });
    expect(pickVerifyTarget([hidden], {}, { memoryDir: memDir, now: NOW })).toBeNull();
  });

  test("全部是 agent_action 时返回 null，不抛", () => {
    const a = header(memDir, "a.md", { mtimeMs: NOW - 90 * DAY, source: "agent_action" });
    const b = header(memDir, "b.md", { mtimeMs: NOW - 90 * DAY, source: "agent_action" });
    expect(pickVerifyTarget([a, b], {}, { memoryDir: memDir, now: NOW })).toBeNull();
  });

  test("空清单返回 null", () => {
    expect(pickVerifyTarget([], {}, { memoryDir: memDir, now: NOW })).toBeNull();
  });

  test("staleDays 可调（判据不是写死的常量）", () => {
    const h = header(memDir, "project_x.md", { mtimeMs: NOW - 3 * DAY });
    const stats = { "project_x.md": { lastRead: NOW - 3 * DAY, readCount: 1 } };
    // 缺省 7 天：3 天不够
    expect(pickVerifyTarget([h], stats, { memoryDir: memDir, now: NOW })).toBeNull();
    // 显式放宽到 2 天：够
    expect(pickVerifyTarget([h], stats, { memoryDir: memDir, now: NOW, staleDays: 2 })?.key).toBe(
      "project_x",
    );
  });

  test("key 取 frontmatter name，不是文件名（与 save_memory 的更新口径一致）", () => {
    const h = header(memDir, "project_file-name.md", {
      mtimeMs: NOW - 30 * DAY,
      name: "logical-key",
    });
    const picked = pickVerifyTarget([h], {}, { memoryDir: memDir, now: NOW });
    expect(picked?.key).toBe("logical-key");
    expect(picked?.filename).toBe("project_file-name.md");
  });

  test("子目录条目按相对路径匹配读计数（不是裸文件名）", () => {
    const sub: MemoryHeader = {
      ...header(memDir, "y.md", { mtimeMs: NOW - 30 * DAY }),
      filePath: join(memDir, "sub", "y.md"),
    };
    const stats: Record<string, MemoryReadStat> = {
      // 只记了根目录同名文件的读计数 —— 不该被当成「y.md 刚读过」
      "sub/y.md": { lastRead: NOW - 30 * DAY, readCount: 1 },
    };
    expect(pickVerifyTarget([sub], stats, { memoryDir: memDir, now: NOW })?.neverRead).toBe(false);
    // 换成只记根目录那条，子目录这条应视为从未读过
    const wrongStats: Record<string, MemoryReadStat> = {
      "y.md": { lastRead: NOW, readCount: 1 },
    };
    expect(pickVerifyTarget([sub], wrongStats, { memoryDir: memDir, now: NOW })?.neverRead).toBe(
      true,
    );
  });
});

// ─── 频率 ───────────────────────────────────────────────────────

describe("shouldVerifyThisRound / resolveVerifyEvery", () => {
  test("每 N 次触发；0 = 关闭", () => {
    expect(shouldVerifyThisRound(5, 5)).toBe(true);
    expect(shouldVerifyThisRound(10, 5)).toBe(true);
    expect(shouldVerifyThisRound(4, 5)).toBe(false);
    expect(shouldVerifyThisRound(0, 5)).toBe(false);
    // 0 = 显式关闭，不是「每 0 次」这种会除零的写法
    expect(shouldVerifyThisRound(5, 0)).toBe(false);
    expect(shouldVerifyThisRound(5, -1)).toBe(false);
  });

  test("缺省值：每 5 次、7 天", () => {
    expect(resolveVerifyEvery()).toBe(DEFAULT_VERIFY_EVERY);
    expect(DEFAULT_VERIFY_EVERY).toBe(5);
    expect(DEFAULT_STALE_DAYS).toBe(7);
  });

  test("env 覆盖：0 合法（关闭）、非法值回落缺省", () => {
    process.env.SID_CODE_MEMORY_VERIFY_EVERY = "0";
    expect(resolveVerifyEvery()).toBe(0);
    process.env.SID_CODE_MEMORY_VERIFY_EVERY = "3";
    expect(resolveVerifyEvery()).toBe(3);
    // 拼错的值不该把功能静默关掉，也不该变成「每 0 次」
    process.env.SID_CODE_MEMORY_VERIFY_EVERY = "-2";
    expect(resolveVerifyEvery()).toBe(DEFAULT_VERIFY_EVERY);
    process.env.SID_CODE_MEMORY_VERIFY_EVERY = "abc";
    expect(resolveVerifyEvery()).toBe(DEFAULT_VERIFY_EVERY);
  });
});

// ─── 提示词二选一 ───────────────────────────────────────────────

describe("buildExtractPrompt — 核实段与「不要验证」段二选一", () => {
  const MANIFEST = "- [project] foo.md (2026-01-01): 示例";
  const TARGET = { key: "project_foo", filename: "project_foo.md", idleDays: 30, neverRead: false };

  test("不传核实目标 → 保持原样（回归保护：正常轮次仍然不许查源码）", () => {
    const prompt = buildExtractPrompt(MANIFEST);
    expect(prompt).toContain("## 不要验证（预算只够写，不够查）");
    expect(prompt).not.toContain("本轮额外任务");
    expect(prompt).toContain("不要为了确认旧记忆是否仍然准确去读代码");
  });

  test("传核实目标 → 出现核实段，且「不要验证」的硬禁止被替换掉", () => {
    const prompt = buildExtractPrompt(MANIFEST, undefined, TARGET);
    expect(prompt).toContain("本轮额外任务：核实一条旧记忆");
    expect(prompt).toContain("project_foo");
    expect(prompt).toContain("30 天没有被读过");
    // 二选一的核心断言：那句「不要为了确认旧记忆是否仍然准确去读代码」必须消失
    // （它和核实任务直接冲突，模型看到两句话会选保守那条，核实永远不会发生）
    expect(prompt).not.toContain("不要为了确认旧记忆是否仍然准确去读代码");
  });

  test("核实段给出写回规则：不成立要写「纠正：」，成立则什么都不做", () => {
    const prompt = buildExtractPrompt(MANIFEST, undefined, TARGET);
    // 与 P1-1 的闸门对齐：这条正是 conclusion_replation 认的放行标记
    expect(prompt).toContain("纠正：");
    expect(prompt).toContain("什么都不做");
    // 不许为了「证明核实过」重写文件（会把 mtime 推新，污染新鲜度判断）
    expect(prompt).toContain("mtime");
  });

  test("从未读过的目标会额外说明（信号更强）", () => {
    const prompt = buildExtractPrompt(MANIFEST, undefined, { ...TARGET, neverRead: true });
    expect(prompt).toContain("从没被读过");
  });
});

// ─── extractor 集成：频率与预算 ─────────────────────────────────

function fakeFork(calls: { n: number }, captured: Array<{ maxTurns?: number; prompt: string }>) {
  return (async (_ctx: unknown, opts: { maxTurns?: number; promptMessages: any[] }) => {
    calls.n++;
    captured.push({
      maxTurns: opts.maxTurns,
      prompt: opts.promptMessages[0]?.content?.[0]?.text ?? "",
    });
    return {
      messages: [],
      usage: { inputTokens: 10, outputTokens: 1 },
      turns: 1,
      deniedToolCalls: 0,
    };
  }) as any;
}

describe("extractor 集成：核实轮次的频率与预算", () => {
  function makeHandle(verifyEvery: number | undefined, calls: { n: number }, captured: any[]) {
    const dir = join(tmpHome, "mem");
    mkdirSync(dir, { recursive: true });
    // 造一条 30 天没读过、也不进索引的条目？不 —— 要造一条**能进索引**的旧条目，
    // 否则 pickVerifyTarget 永远返回 null，测不到核实分支。
    writeFileSync(
      join(dir, "project_old.md"),
      "---\nname: project_old\ndescription: d\ntype: project\nsource: user_explicit\n---\n\nbody\n",
    );
    // 21 天前写入（mtime 由 fs 决定，pickVerifyTarget 在测试里用真实 now 判年龄，
    // 所以这里只能靠「没读过 + 文件很旧」的自然条件；用 utimes 显式设旧时间）
    const old = new Date(Date.now() - 30 * DAY);
    require("node:fs").utimesSync(join(dir, "project_old.md"), old, old);

    return initExtractMemories({
      getMainContext: () => ({ messages: [] }) as any,
      memoryDir: dir,
      canUseTool: () => ({ behavior: "allow" }),
      verifyEvery,
      runFork: fakeFork(calls, captured),
    });
  }

  async function drain(): Promise<void> {
    // executeExtract 是 fire-and-forget（生产语义），等微任务 + 一个宏任务把链排干
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
  }

  test("verifyEvery=2：第 2 次提取带核实段且 maxTurns=6，第 1 次没有", async () => {
    const calls = { n: 0 };
    const captured: any[] = [];
    const h = makeHandle(2, calls, captured);

    await h.executeExtract();
    await drain();
    expect(calls.n).toBe(1);
    expect(captured[0]?.maxTurns).toBe(5);
    expect(captured[0]?.prompt).not.toContain("本轮额外任务");

    await h.executeExtract();
    await drain();
    expect(calls.n).toBe(2);
    expect(captured[1]?.maxTurns).toBe(6);
    expect(captured[1]?.prompt).toContain("本轮额外任务：核实一条旧记忆");
    expect(captured[1]?.prompt).toContain("project_old");
  });

  test("verifyEvery=0：永不带核实段（显式关闭）", async () => {
    const calls = { n: 0 };
    const captured: any[] = [];
    const h = makeHandle(0, calls, captured);

    for (let i = 0; i < 4; i++) {
      await h.executeExtract();
      await drain();
    }
    expect(calls.n).toBe(4);
    for (const c of captured) {
      expect(c.maxTurns).toBe(5);
      expect(c.prompt).not.toContain("本轮额外任务");
    }
  });
});
