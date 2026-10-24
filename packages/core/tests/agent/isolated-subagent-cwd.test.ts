/**
 * 隔离 worktree 子代理的工作目录口径（§3 ② 进程层）
 *
 * 背景：`withAgentCwd` 只改 ALS 里的 cwd、不 chdir，于是子代理里任何直接读 `process.cwd()`
 * 的地方拿到的都是主仓根。实测（本机轨迹 2026-10-16~22，11 个隔离子代理）：
 * 系统提示词写的「当前工作目录」是主仓、D13 隔离提示零次出现，529 次带路径工具调用里
 * 501 次打在主仓绝对路径上。这里锁住修复后的四条不变式：
 *
 * 1. 系统提示词的工作目录 = 隔离 worktree，且隔离提示出现、点名 worktree 根与主仓根
 * 2. 子代理 JIT 以 worktree 根为项目根（加载 worktree 的规则文件，不是主仓那份）
 * 3. bash 在子代理 cwd 失效时不回退到主会话启动目录
 * 4. SubagentStart 事件带 isolation / agent_cwd，agent_cwd 上传前剥离
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import {
  withAgentCwd,
  splitIsolatedWorktreePath,
  getIsolatedWorktree,
} from "@sid-code/core/bootstrap/cwd-context.ts";
import { BashTool } from "@sid-code/core/tool/bash.ts";
import { setJitTraceSink } from "@sid-code/core/trace/jit-telemetry.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { stripLocalOnlyEventFields } from "@sid-code/core/trace/uploader.ts";
import { SidechainWriter } from "@sid-code/core/session/sidechain.ts";

/** 记下每次请求的 system 提示词；第一轮调一次 read 触发 JIT，第二轮收尾。 */
class RecordingProvider implements Provider {
  systems: string[] = [];
  private turn = 0;
  constructor(private readonly readPath?: string) {}
  name() {
    return "recording";
  }
  defaultModel() {
    return "m";
  }
  async *sendMessageStream(params: SendParams): AsyncIterable<StreamEvent> {
    this.systems.push(String(params.system ?? ""));
    const t = this.turn++;
    yield {
      type: "message_start",
      message: { id: `m${t}`, role: "assistant", usage: { inputTokens: 1, outputTokens: 0 } },
    } as StreamEvent;
    if (t === 0 && this.readPath) {
      yield {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "read", input: {} },
      } as StreamEvent;
      yield {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({ file_path: this.readPath }),
        },
      } as StreamEvent;
      yield { type: "content_block_stop", index: 0 } as StreamEvent;
      yield {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { outputTokens: 1 },
      } as StreamEvent;
      return;
    }
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    } as StreamEvent;
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "## 结论\n完成" },
    } as StreamEvent;
    yield { type: "content_block_stop", index: 0 } as StreamEvent;
    yield {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { outputTokens: 1 },
    } as StreamEvent;
  }
}

/** 只读的 read 桩：声明 jitAffectedPaths，让 JIT 发现能被触发 */
class StubRead implements LegacyTool {
  name() {
    return "read";
  }
  description() {
    return "read";
  }
  inputSchema() {
    return { type: "object", properties: { file_path: { type: "string" } } };
  }
  readOnly() {
    return true;
  }
  jitAffectedPaths(input: unknown): string[] {
    const p = (input as { file_path?: string })?.file_path;
    return p ? [p] : [];
  }
  async execute(): Promise<LegacyToolResult> {
    return { output: "ok" };
  }
}

const MAIN_RULE = "MAIN_REPO_RULE ".repeat(20) + "\n";
let base: string;
let mainRepo: string;
let worktree: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "sid-iso-cwd-")));
  mainRepo = join(base, "repo");
  worktree = join(mainRepo, ".sid-code", "worktrees", "agent-test");
  mkdirSync(join(worktree, "src"), { recursive: true });
  mkdirSync(join(mainRepo, "src"), { recursive: true });
  // 两份规则文件内容不同：据此判定 JIT 加载的是哪一份
  // 两份规则文件字节数不同：JIT 事件只记相对路径（两份都是 src/CLAUDE.md），靠 bytes 区分加载的是哪一份
  writeFileSync(join(mainRepo, "src", "CLAUDE.md"), MAIN_RULE);
  writeFileSync(join(worktree, "src", "CLAUDE.md"), "WORKTREE_RULE\n");
  writeFileSync(join(worktree, "src", "a.ts"), "x\n");
});

afterEach(() => {
  setJitTraceSink(null);
  rmSync(base, { recursive: true, force: true });
});

describe("splitIsolatedWorktreePath", () => {
  test("worktree 根与其子目录都解析出同一个根和主仓", () => {
    expect(splitIsolatedWorktreePath(worktree)).toEqual({ worktreeRoot: worktree, mainRepo });
    expect(splitIsolatedWorktreePath(join(worktree, "src", "x"))).toEqual({
      worktreeRoot: worktree,
      mainRepo,
    });
  });

  test("主仓路径 / worktrees 容器目录本身不是隔离 worktree", () => {
    expect(splitIsolatedWorktreePath(mainRepo)).toBeNull();
    expect(splitIsolatedWorktreePath(join(mainRepo, ".sid-code", "worktrees") + "/")).toBeNull();
  });

  test("getIsolatedWorktree 按进入时的 root 判，cd 不改变边界", () => {
    expect(getIsolatedWorktree()).toBeNull();
    withAgentCwd(join(worktree, "src"), () => {
      expect(getIsolatedWorktree()?.worktreeRoot).toBe(worktree);
    });
  });
});

describe("隔离子代理的系统提示词", () => {
  test("工作目录是 worktree，隔离提示出现并点名两个根", async () => {
    const provider = new RecordingProvider();
    const reg = new Registry();
    reg.register(new StubRead());
    const agent = new SubAgent(provider, "m", reg);
    const r = await agent.execute({
      type: "explore",
      description: "核验",
      prompt: "看看",
      cwd: worktree,
    });
    expect(r.success).toBe(true);
    const sys = provider.systems[0];
    expect(sys).toContain(`当前工作目录: ${worktree}`);
    expect(sys).not.toContain(`当前工作目录: ${process.cwd()}\n`);
    expect(sys).toContain("【隔离环境提示】");
    expect(sys).toContain(`根目录: ${worktree}`);
    expect(sys).toContain(mainRepo);
  });

  test("未绑定 cwd 时不出现隔离提示（主仓子代理行为不变）", async () => {
    const provider = new RecordingProvider();
    const agent = new SubAgent(provider, "m", new Registry());
    await agent.execute({ type: "explore", description: "核验", prompt: "看看" });
    expect(provider.systems[0]).not.toContain("【隔离环境提示】");
  });

  test("自定义子代理路径同样支持 cwd（此前无此字段）", async () => {
    const provider = new RecordingProvider();
    const agent = new SubAgent(provider, "m", new Registry());
    await agent.executeCustom({
      systemPrompt: "你是验证器",
      userPrompt: "看看",
      allowedTools: [],
      cwd: worktree,
    });
    expect(provider.systems[0]).toContain(`当前工作目录: ${worktree}`);
    expect(provider.systems[0]).toContain("【隔离环境提示】");
  });
});

describe("隔离子代理的 JIT 上下文", () => {
  test("相对路径按 worktree 根解析，加载 worktree 的规则文件并标记 isolated_worktree", async () => {
    const events: Record<string, unknown>[] = [];
    setJitTraceSink((d) => events.push(d));
    const provider = new RecordingProvider("src/a.ts");
    const reg = new Registry();
    reg.register(new StubRead());
    const agent = new SubAgent(provider, "m", reg);
    await agent.execute({ type: "explore", description: "核验", prompt: "看看", cwd: worktree });
    // JIT 串行队列异步跑完
    await new Promise((r) => setTimeout(r, 50));

    const ev = events.find((e) => e.source === "subagent");
    expect(ev).toBeDefined();
    expect(ev!.isolated_worktree).toBe(true);
    expect(ev!.accessed_path).toBe(join("src", "a.ts"));
    expect(ev!.hit).toBe(true);
    // 加载的是 worktree 那份，不是主仓那份。`bytes` 是格式化后整块长度（含包装头），
    // 主仓那份原文就有 301 字节、包装后只会更长 —— 小于它即可判定来源。
    // 不断言系统提示词：JIT 注入异步于下一轮请求，那是时序而不是口径。
    const loaded = ev!.loaded as Array<{ path: string; bytes: number }>;
    const rule = loaded.find((l) => l.path === join("src", "CLAUDE.md"));
    expect(rule).toBeDefined();
    expect(rule!.bytes).toBeLessThan(MAIN_RULE.length);
  });
});

describe("bash 在子代理 cwd 失效时的兜底", () => {
  test("cwd 目录被删：回退到子代理自己的根，不是主会话启动目录", async () => {
    const sub = join(worktree, "gone");
    mkdirSync(sub);
    const bash = new BashTool();
    const out = await withAgentCwd(worktree, async () => {
      await bash.execute({ command: `cd ${JSON.stringify(sub)}` });
      rmSync(sub, { recursive: true, force: true });
      return bash.execute({ command: "pwd -P" });
    });
    expect(out.isError).toBeFalsy();
    expect(out.output).toContain(worktree);
  });

  test("子代理根也没了：报错且不执行，不落到主仓", async () => {
    const doomed = join(mainRepo, ".sid-code", "worktrees", "agent-doomed");
    mkdirSync(doomed, { recursive: true });
    const marker = join(base, "ran.txt");
    const bash = new BashTool();
    const out = await withAgentCwd(doomed, async () => {
      rmSync(doomed, { recursive: true, force: true });
      return bash.execute({ command: `touch ${JSON.stringify(marker)}` });
    });
    expect(out.isError).toBe(true);
    expect(out.output).toContain("已不存在");
    expect(() => readFileSync(marker)).toThrow();
  });
});

describe("SubagentStart 的隔离字段", () => {
  test("落盘 isolation / agent_cwd；agent_cwd 上传前被剥离", async () => {
    const outDir = join(base, "traj");
    mkdirSync(outDir, { recursive: true });
    const hookSystem = new HookSystem();
    hookSystem.setSessionId("sess-iso");
    hookSystem.setCwd(mainRepo);
    const collector = new TraceCollector({ outputDir: outDir });
    collector.registerHooks(hookSystem);
    await hookSystem.fireSessionStartEvent("startup", { model: "m" });

    const agent = new SubAgent(new RecordingProvider(), "m", new Registry(), hookSystem);
    await agent.execute({ type: "explore", description: "核验", prompt: "看看", cwd: worktree });

    const text = readFileSync(join(outDir, "sessions", "sess-iso", "events.jsonl"), "utf-8");
    const start = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event?: string; data?: Record<string, unknown> })
      .find((r) => r.event === "SubagentStart");
    expect(start?.data?.isolation).toBe("worktree");
    expect(start?.data?.agent_cwd).toBe(worktree);

    const uploaded = stripLocalOnlyEventFields(text);
    expect(uploaded).not.toContain('"agent_cwd"');
    expect(uploaded).toContain('"isolation":"worktree"');
  });
});

describe("sidechain_start 落盘子代理的系统提示词与工作目录", () => {
  const saved = process.env.SID_CONFIG_DIR;
  beforeEach(() => {
    process.env.SID_CONFIG_DIR = join(base, "home");
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = saved;
  });

  test("隔离子代理的 sidechain 首行带 systemPrompt 与 cwd", async () => {
    const provider = new RecordingProvider();
    const agent = new SubAgent(provider, "m", new Registry());
    agent.setParentSessionId("sess-sc");
    await agent.execute({ type: "explore", description: "核验", prompt: "看看", cwd: worktree });
    const w = new SidechainWriter("sess-sc", "probe");
    const dir = join(w.getFilePath(), "..");
    const { readdirSync } = await import("fs");
    const file = readdirSync(dir).find((n) => n.startsWith("sess-sc-") && !n.includes("probe"));
    expect(file).toBeDefined();
    const first = JSON.parse(readFileSync(join(dir, file!), "utf-8").split("\n")[0]);
    expect(first.type).toBe("sidechain_start");
    expect(first.cwd).toBe(worktree);
    expect(first.systemPrompt).toContain("【隔离环境提示】");
  });

  test("未 start 就 end 不落任何文件（防首行 sidechain_end 被当成主会话文件）", () => {
    const w = new SidechainWriter("sess-noop", "a1");
    w.end("aborted");
    expect(() => readFileSync(w.getFilePath())).toThrow();
  });
});
