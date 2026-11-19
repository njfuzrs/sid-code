/**
 * workflow 子代理两个缺陷的回归（2026-11-19，A1 + A3）
 *
 * A1（P0）：agent() 声明了 schema 时，模型返回非 JSON 文本被静默降级成字符串。
 *   实测：同一编排脚本给 4 个 agent 传同一 schema，3 个拿到校验后的对象、1 个拿到一整段
 *   markdown；编排脚本的 `results.filter(r => r.status === "done")` 对字符串静默得到
 *   undefined、不抛错，汇总静默漏掉一个单元。修复后该路径返回 null（编排器可判定失败），
 *   且 WARN 日志里留原文片段，避免「弃用」变成「彻底丢掉证据」。
 *
 * A3（P2）：worktree 创建期 setupWarnings 只进日志，子代理自己看不到，只能在
 *   pre-commit 报 Cannot find module 时反推。修复后非空告警拼进子代理 prompt；
 *   无告警时 prompt 逐字节不变。
 *
 * 两种观测手法：
 *  - SubAgent.prototype.execute mock（同 sub-agent-perm-injection.test.ts）——不真跑子代理
 *    循环，直接拿到 run() 实际构造的 task（含 prompt / schema）并控制 output。
 *  - initLogger 把 WARN 落到 tmpdir 下的文件再读盘，而不是 mock.module 拦 getLogger：
 *    logger 是单例且被 sub-agent-runner 在调用时 getLogger() 取，initLogger 就地
 *    reconfigure 同一实例，不需要拦模块，也不会和同批其它测试的 mock 生命周期打架。
 *    落盘目标显式指向 tmpdir（SID_CONFIG_DIR 不是必需，但 logFile 本身就是绝对 tmp 路径）。
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import type { SubAgentResult } from "@sid-code/core/agent/sub-agent.ts";
import { WorktreeManager } from "@sid-code/core/worktree/manager.ts";
import { SubAgentRunner } from "@sid-code/core/workflow/sub-agent-runner.ts";
import { initLogger, LogLevel } from "@sid-code/core/debug/logger.ts";

/** 最小假 registry：fromRegistry 只需要这三个方法 */
const fakeRegistry = {
  getProvider: () => ({}),
  getCurrentModel: () => "test-model",
  getLanguage: () => "zh",
} as any;

const ctx = (label = "t") => ({
  callIndex: 0,
  label,
  signal: new AbortController().signal,
});

/** execute 实际收到的 task（prompt/schema 都是 run() 构造出来的那一份） */
let capturedTask: { prompt?: string; schema?: unknown; cwd?: string } | null = null;

const origExecute = SubAgent.prototype.execute;
const origCreate = WorktreeManager.prototype.create;
// remove 必须一起存原值：stubCreate 会把 create 和 remove 成对换掉，
// 少恢复 remove 会让同进程里后跑的测试拿到「返回 true 但不删目录」的桩
// （2026-11-19 CI 实测：worktree/symlink-pollution.test.ts 整组 8 条断言因此失败，
//  表现为「remove 返回 true 但目录仍在」「removeThrows 拿不到异常」）。
const origRemove = WorktreeManager.prototype.remove;
const origFindGitRoot = (await import("@sid-code/core/worktree/manager.ts")).findGitRootForAgent;
const { setCwd } = await import("@sid-code/core/bootstrap/state.ts");
const origCwd = process.cwd();

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sid-wf-schema-warn-"));
  tmpDirs.push(d);
  return d;
}

/** 把 execute 换成返回固定 output 的桩，并记录 task */
function stubExecute(output: string, success = true): void {
  SubAgent.prototype.execute = async function (
    this: SubAgent,
    task: { prompt?: string; schema?: unknown; cwd?: string },
  ): Promise<SubAgentResult> {
    capturedTask = task;
    return {
      success,
      output,
      toolUseCount: 0,
      usage: { inputTokens: 1, outputTokens: 2 },
    } as unknown as SubAgentResult;
  };
}

/** 把 WorktreeManager.create 换成返回固定 session 的桩（不真建 worktree） */
function stubCreate(warnings: string[] | undefined, worktreePath: string): void {
  WorktreeManager.prototype.create = async function (slug: string) {
    return {
      originalCwd: origCwd,
      worktreePath,
      worktreeName: slug,
      sessionId: "test-session",
      worktreeBranch: `branch-${slug}`,
      originalHeadCommit: "0".repeat(40),
      creationDurationMs: 1,
      setupWarnings: warnings,
    } as any;
  };
  WorktreeManager.prototype.remove = async function () {
    return true;
  };
}

/** 让 run() 的 findGitRootForAgent 认为当前在 git 仓库里（不真建仓，路径不会被动到） */
async function stubGitRoot(dir: string): Promise<void> {
  const managerModule = await import("@sid-code/core/worktree/manager.ts");
  // ESM 命名导出不可重赋值，改用模块对象上的可变属性——bun 的 CJS 互操作下可以；
  // 若不可写则退化为真实 git 探测（本测试的 cwd 在仓库内，天然命中）。
  try {
    (managerModule as any).findGitRootForAgent = () => dir;
  } catch {
    /* 只读导出：cwd 在仓库内即可，null 检查 见下 */
  }
  void origFindGitRoot;
}

beforeEach(() => {
  capturedTask = null;
});

afterEach(() => {
  SubAgent.prototype.execute = origExecute;
  WorktreeManager.prototype.create = origCreate;
  WorktreeManager.prototype.remove = origRemove;
  capturedTask = null;
  // logger 是全局单例，initLogger 是就地 reconfigure：不恢复的话，同批后续测试
  // 的 WARN 都会往本文件已删掉的 tmp 路径写（静默失败，现场全丢）。
  initLogger({ enabled: false });
  try {
    setCwd(origCwd);
    process.chdir(origCwd);
  } catch {
    /* 分支里已改回，不再重复 */
  }
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
});

function makeRunner(): SubAgentRunner {
  return new SubAgentRunner({
    providerRegistry: fakeRegistry,
    toolRegistry: {} as any,
    runId: "schema-warnings-test",
  });
}

describe("A1：schema + 非 JSON 输出 → null，日志留原文片段", () => {
  test("返回 null，且日志同时含「按失败返回 null」与原文片段", async () => {
    const dir = makeTmpDir();
    const logFile = join(dir, "debug.log");
    initLogger({ enabled: true, level: LogLevel.WARN, logFile, console: false, fileOnly: true });

    const raw = "## 汇总\n\n单元 2 已完成，下面是 markdown 而不是 JSON。";
    stubExecute(raw);

    const result = await makeRunner().run("原始任务", { schema: { type: "object" } } as any, ctx());

    // ① 判失败：必须是 null，不能是字符串
    expect(result).toBeNull();

    const lg = (await import("@sid-code/core/debug/logger.ts")).getLogger();
    await lg.flush();
    const log = readFileSync(logFile, "utf8");
    // ② 可判定为失败的字样
    expect(log).toContain("按失败返回 null");
    // ③ 原文留痕：只断 ② 的话，「返回 null 但把原文彻底丢掉」的实现也能通过
    expect(log).toContain(raw.slice(0, 500));
  });
});

describe("A1：schema 正常路径不误伤", () => {
  test("schema + 合法 JSON → 返回解析后的对象", async () => {
    stubExecute(JSON.stringify({ status: "done", summary: "ok" }));
    const result = await makeRunner().run(
      "p",
      { schema: { type: "object", properties: { status: { type: "string" } } } } as any,
      ctx(),
    );
    expect(result).toEqual({ status: "done", summary: "ok" });
  });

  test("无 schema → 返回原始文本（回归：与改动前一致）", async () => {
    stubExecute("## 汇总\n\n纯文本结果");
    const result = await makeRunner().run("p", undefined, ctx());
    expect(result).toBe("## 汇总\n\n纯文本结果");
  });
});

describe("A3：worktree 创建期告警进 prompt", () => {
  test("有 setupWarnings → prompt 含告警文本与「请先修复或规避」", async () => {
    const dir = makeTmpDir();
    await stubGitRoot(dir);
    stubCreate(["依赖未安装：@sid-code/tui"], dir);
    stubExecute("ok");

    await makeRunner().run("原始 prompt 内容", { isolation: "worktree" } as any, ctx());

    expect(capturedTask).not.toBeNull();
    const prompt = capturedTask!.prompt!;
    expect(prompt).toContain("依赖未安装：@sid-code/tui");
    expect(prompt).toContain("请先修复或规避");
    expect(prompt).toContain("[Worktree 环境告警]");
    // 原 prompt 仍然是开头（拼接而不是替换）
    expect(prompt.startsWith("原始 prompt 内容")).toBe(true);
  });

  test("无 setupWarnings → prompt 与原始 prompt 完全相等（逐字节）", async () => {
    const dir = makeTmpDir();
    await stubGitRoot(dir);
    stubCreate(undefined, dir);
    stubExecute("ok");

    const original = "原始 prompt 内容\n带换行 与 尾随空格 ";
    await makeRunner().run(original, { isolation: "worktree" } as any, ctx());

    expect(capturedTask).not.toBeNull();
    expect(capturedTask!.prompt).toBe(original);
  });
});
