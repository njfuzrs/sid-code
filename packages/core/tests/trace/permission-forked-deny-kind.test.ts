/**
 * forked 拒绝的类别（denyKind）与路径形状（pathMismatch）。
 *
 * 起因：04 权限决策横向剖析核出 `fork:session-memory-update` 的 edit 拒绝率 43%
 * （621 / 1,445，跨 74 会话），假设是更新提示词没给笔记路径、模型靠猜。forked 路径的
 * PermissionDecision 只有 `reason_type: "other"`，请求正文也不落盘，坐实不了。
 * 方案：docs-research `bugfixes/todo/20261031-session-memory-fork-edit拒绝率43%-提示词缺笔记路径.md` 步骤 A。
 *
 * 覆盖三段：
 *  1. 两个权限函数的每个 deny 分支都报 denyKind；path_mismatch 带布尔形状、不含路径原文；
 *  2. runForkedAgent 原样转发，权限函数没报时事件里不出现该 key（与旧数据同形）；
 *  3. collector 落成 events.jsonl 的 `deny_kind` / `path_mismatch`。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runForkedAgent, type ForkedAgentContext } from "@sid-code/core/agent/forked-agent.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import {
  createExtractPermissions,
  createSessionMemoryPermissions,
  describePathMismatch,
} from "@sid-code/core/memory/extract/permissions.ts";
import {
  setPermissionDecisionObserver,
  type PermissionDecisionEvent,
} from "@sid-code/core/permission/decision-telemetry.ts";
import { logPermissionDeny } from "@sid-code/core/analytics/events.ts";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import type { PermissionResult } from "@sid-code/core/tool/types.ts";

type Deny = Extract<PermissionResult, { behavior: "deny" }>;
const asDeny = (r: PermissionResult | Promise<PermissionResult>): Deny => {
  const d = r as PermissionResult;
  expect(d.behavior).toBe("deny");
  return d as Deny;
};

// ─── 1. 权限函数自报类别 ───

describe("createSessionMemoryPermissions · denyKind", () => {
  const notes = "/home/u/.sid-code/projects/p-key/session-memory/sess-1.md";
  const perms = createSessionMemoryPermissions(notes);

  test("猜成旧的项目级单文件 ⇒ path_mismatch，形状指出「同项目、换了名字」", () => {
    const d = asDeny(
      perms("edit", { file_path: "/home/u/.sid-code/projects/p-key/.session_memory.md" }),
    );
    expect(d.denyKind).toBe("path_mismatch");
    expect(d.pathMismatch).toEqual({
      sameBasename: false,
      sameDir: false,
      isRelative: false,
      underAuthorizedRoot: true,
    });
  });

  test("给相对路径 ⇒ isRelative=true", () => {
    const d = asDeny(perms("edit", { file_path: ".session_memory.md" }));
    expect(d.denyKind).toBe("path_mismatch");
    expect(d.pathMismatch?.isRelative).toBe(true);
  });

  test("文件名对、目录错 ⇒ sameBasename=true", () => {
    const d = asDeny(perms("write", { file_path: "/tmp/sess-1.md" }));
    expect(d.pathMismatch).toMatchObject({ sameBasename: true, sameDir: false });
  });

  test("形状里只有布尔，不带路径原文", () => {
    const d = asDeny(perms("edit", { file_path: "/secret/project/name.md" }));
    for (const v of Object.values(d.pathMismatch ?? {})) expect(typeof v).toBe("boolean");
    expect(JSON.stringify(d.pathMismatch)).not.toContain("secret");
  });

  test("取不到路径 ⇒ no_target_path", () => {
    expect(asDeny(perms("edit", {})).denyKind).toBe("no_target_path");
  });

  test("非只读 bash ⇒ bash_not_readonly；其他工具 ⇒ tool_not_allowed", () => {
    expect(asDeny(perms("bash", { command: "rm -rf x" })).denyKind).toBe("bash_not_readonly");
    expect(asDeny(perms("save_memory", {})).denyKind).toBe("tool_not_allowed");
  });

  test("授权文件本身仍然放行", () => {
    expect((perms("edit", { file_path: notes }) as PermissionResult).behavior).toBe("allow");
  });
});

describe("createExtractPermissions · denyKind", () => {
  const memDir = "/home/u/.sid-code/projects/p-key/memory";
  const perms = createExtractPermissions(memDir);

  test("写到记忆目录外 ⇒ path_mismatch", () => {
    const d = asDeny(perms("write", { file_path: "/etc/passwd" }));
    expect(d.denyKind).toBe("path_mismatch");
    expect(d.pathMismatch).toMatchObject({ sameDir: false, underAuthorizedRoot: false });
  });

  test("save_memory 越权 scope ⇒ scope_denied", () => {
    expect(asDeny(perms("save_memory", { scope: "global" })).denyKind).toBe("scope_denied");
  });

  test("bash / 其他工具 / 无路径", () => {
    expect(asDeny(perms("bash", { command: "echo x > f" })).denyKind).toBe("bash_not_readonly");
    expect(asDeny(perms("web_fetch", {})).denyKind).toBe("tool_not_allowed");
    expect(asDeny(perms("edit", {})).denyKind).toBe("no_target_path");
  });
});

describe("describePathMismatch", () => {
  test("目录授权：目录内算 sameDir", () => {
    expect(describePathMismatch("/m/a/b.md", "/m/a", "dir").sameDir).toBe(true);
    expect(describePathMismatch("/m/ab.md", "/m/a", "dir").sameDir).toBe(false);
  });
});

// ─── 2. runForkedAgent 转发 ───

class EditTool {
  name() {
    return "edit";
  }
  description() {
    return "编辑";
  }
  inputSchema() {
    return { type: "object", properties: { file_path: { type: "string" } } };
  }
  async execute() {
    return { output: "ok" };
  }
  readOnly() {
    return false;
  }
}

function forkCtx(paths: string[]): ForkedAgentContext {
  let call = 0;
  const provider = {
    name: () => "mock",
    defaultModel: () => "mock-model",
    async *sendMessageStream() {
      const n = call++;
      if (n < paths.length) {
        yield {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: `t${n}`, name: "edit" },
        };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({ file_path: paths[n] }),
          },
        };
        yield { type: "content_block_stop", index: 0 };
        yield {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { outputTokens: 1 },
        };
        return;
      }
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "完成" } };
      yield { type: "content_block_stop", index: 0 };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { outputTokens: 1 },
      };
    },
  };
  const registry = new ToolRegistry();
  registry.register(new EditTool() as any);
  return {
    systemPrompt: "s",
    messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    provider: provider as any,
    toolRegistry: registry,
    model: "mock-model",
    statefulTools: [],
  };
}

describe("runForkedAgent · 转发 denyKind", () => {
  let got: PermissionDecisionEvent[];
  beforeEach(() => {
    got = [];
    setPermissionDecisionObserver((e) => got.push(e));
  });
  afterEach(() => setPermissionDecisionObserver(null));

  test("权限函数报了 ⇒ 事件带 denyKind + pathMismatch；reasonType 仍是 other", async () => {
    const notes = "/n/session-memory/s.md";
    await runForkedAgent(forkCtx(["/n/.session_memory.md", notes]), {
      promptMessages: [{ role: "user", content: [{ type: "text", text: "更新" }] }],
      canUseTool: createSessionMemoryPermissions(notes),
      maxTurns: 5,
      querySource: "session-memory-update",
    });
    const deny = got.find((e) => e.outcome === "deny")!;
    expect(deny).toMatchObject({
      context: "forked",
      reasonType: "other",
      denyKind: "path_mismatch",
    });
    expect(deny.pathMismatch?.underAuthorizedRoot).toBe(true);
    // 第二轮写对了路径：放行事件不带这两个 key
    const allow = got.find((e) => e.outcome === "allow")!;
    expect(Object.keys(allow)).not.toContain("denyKind");
  });

  test("权限函数没报（如 /btw 的一律拒）⇒ 事件里没有 denyKind 这个 key", async () => {
    await runForkedAgent(forkCtx(["/a"]), {
      promptMessages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      canUseTool: () => ({ behavior: "deny", message: "旁路提问不允许使用工具" }),
      maxTurns: 3,
      querySource: "btw",
    });
    const deny = got.find((e) => e.outcome === "deny")!;
    expect(Object.keys(deny)).not.toContain("denyKind");
    expect(Object.keys(deny)).not.toContain("pathMismatch");
  });
});

// ─── 3. collector 落盘 ───

describe("collector 落盘 deny_kind / path_mismatch", () => {
  let dir: string;
  let savedIndex: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sid-denykind-"));
    savedIndex = process.env.SID_CODE_SESSION_INDEX;
    process.env.SID_CODE_SESSION_INDEX = join(dir, "session-index.jsonl");
  });
  afterEach(() => {
    setPermissionDecisionObserver(null);
    if (savedIndex === undefined) delete process.env.SID_CODE_SESSION_INDEX;
    else process.env.SID_CODE_SESSION_INDEX = savedIndex;
    rmSync(dir, { recursive: true, force: true });
  });

  test("forked deny 带 snake_case 字段；不带的事件形状不变", async () => {
    const { HookSystem } = await import("@sid-code/core/hook/system.ts");
    const hooks = new HookSystem();
    hooks.setSessionId("sess-dk");
    hooks.setCwd("/tmp/test");
    const trajDir = join(dir, "trajectories");
    const collector = new TraceCollector({ outputDir: trajDir });
    collector.registerHooks(hooks);
    await hooks.fireSessionStartEvent("startup", { model: "claude-test" });
    // 空白会话会被清掉：补一轮模型调用（同 permission-decision-agent-id-s10.test.ts）
    await hooks.fireBeforeModelEvent({
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      raw_messages: [{ role: "user", content: "hi" }],
    });
    await hooks.fireAfterModelEvent(
      { model: "claude-test", messages: [], raw_messages: [{ role: "user", content: "hi" }] },
      {
        content_blocks: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      } as never,
    );

    logPermissionDeny("edit", {
      source: "other",
      needsPrompt: false,
      context: "forked",
      reasonType: "other",
      agentId: "fork:session-memory-update",
      denyKind: "path_mismatch",
      pathMismatch: {
        sameBasename: false,
        sameDir: false,
        isRelative: true,
        underAuthorizedRoot: false,
      },
    });
    logPermissionDeny("bash", {
      source: "rule",
      needsPrompt: false,
      context: "main",
      reasonType: "rule",
    });
    await hooks.fireSessionEndEvent("exit");

    const decisions = readFileSync(join(trajDir, "sessions", "sess-dk", "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === "PermissionDecision");
    expect(decisions).toHaveLength(2);
    expect(decisions[0].data).toMatchObject({
      deny_kind: "path_mismatch",
      path_mismatch: {
        same_basename: false,
        same_dir: false,
        is_relative: true,
        under_authorized_root: false,
      },
    });
    expect(Object.keys(decisions[1].data)).not.toContain("deny_kind");
    expect(Object.keys(decisions[1].data)).not.toContain("path_mismatch");
  });
});
