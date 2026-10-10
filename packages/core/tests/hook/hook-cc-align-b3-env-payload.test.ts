/**
 * Hook 对齐 CC · 批 3：环境与载荷（HC11 / HC12 / HC14 / HC20）
 *
 * - CLAUDE_PROJECT_DIR = 会话启动时的项目根，cwd 变了它不变；SID_CODE_CWD 随 cwd 变
 * - exec 形式（args）不经 shell，白名单路径占位符做纯字符串替换
 * - stdin：permission_mode（CC 取值）/ sid_permission_mode / transcript_path / prompt_id /
 *   Stop 的 last_assistant_message + stop_hook_active / Failure 的顶层 error + is_interrupt
 * - 缺省超时按 Q5；SessionEnd 共享预算
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRunner, expandPathPlaceholders } from "@sid-code/core/hook/runner.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import {
  HookEventName,
  ConfigSource,
  resolveHookTimeoutMs,
  sessionEndBudgetMs,
} from "@sid-code/core/hook/types.ts";
import { toCcPermissionMode, applySessionEndBudget } from "@sid-code/core/hook/event-handler.ts";

const root = mkdtempSync(join(tmpdir(), "sid-b3-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const baseInput = (cwd: string) =>
  ({ session_id: "s", cwd, hook_event_name: "PostToolUse", timestamp: "" }) as any;

describe("CLAUDE_PROJECT_DIR / SID_CODE_CWD（HC14）", () => {
  test("项目根不随 cwd 变；CWD 随 cwd 变；两套名字值相同", async () => {
    const proj = join(root, "proj");
    const sub = join(proj, "sub");
    mkdirSync(sub, { recursive: true });
    const runner = new HookRunner();
    runner.setProjectDir(proj);
    const r = await runner.executeHook(
      {
        type: "command",
        command: `printf '%s|%s|%s' "$CLAUDE_PROJECT_DIR" "$SID_CODE_PROJECT_DIR" "$SID_CODE_CWD"`,
      },
      HookEventName.PostToolUse,
      baseInput(sub), // 模拟 bash cd 之后
    );
    expect(r.output?.systemMessage).toBe(`${proj}|${proj}|${sub}`);
  });

  test("CC 写法 ${CLAUDE_PROJECT_DIR}/... 脚本路径可用（shell 形式）", async () => {
    const proj = join(root, "proj2");
    mkdirSync(join(proj, ".sid-code/hooks"), { recursive: true });
    const script = join(proj, ".sid-code/hooks/x.sh");
    writeFileSync(script, "#!/bin/sh\nprintf ok\n", { mode: 0o755 });
    const runner = new HookRunner();
    runner.setProjectDir(proj);
    const r = await runner.executeHook(
      { type: "command", command: '"${CLAUDE_PROJECT_DIR}"/.sid-code/hooks/x.sh' },
      HookEventName.PostToolUse,
      baseInput(proj),
    );
    expect(r.exitCode).toBe(0);
    expect(r.output?.systemMessage).toBe("ok");
  });

  test("只导出三个 CLAUDE_* 变量（Q3）", async () => {
    const runner = new HookRunner();
    const r = await runner.executeHook(
      { type: "command", command: "env | grep '^CLAUDE_' | cut -d= -f1 | sort | tr '\\n' ' '" },
      HookEventName.PostToolUse,
      baseInput(root),
    );
    // 非插件来源只有 CLAUDE_PROJECT_DIR（PLUGIN_* 按来源提供）。宿主环境里本来就有的 CLAUDE_* 不算我们导出的。
    const ours = (r.output?.systemMessage ?? "").split(" ").filter((n) => n && !(n in process.env));
    expect(ours).toEqual(["CLAUDE_PROJECT_DIR"]);
  });
});

describe("exec 形式（args，不经 shell）", () => {
  test("参数原样传递、不做 shell 解析；占位符替换", async () => {
    const proj = join(root, "exec");
    mkdirSync(proj, { recursive: true });
    const runner = new HookRunner();
    runner.setProjectDir(proj);
    const out = join(proj, "out.txt");
    const r = await runner.executeHook(
      {
        type: "command",
        command: "/bin/sh",
        // 若经 shell 第二层解析，$(echo PWNED) 会被执行；exec 形式下它只是一个字面参数
        args: [
          "-c",
          'printf "%s|%s" "$1" "$2" > "$3"',
          "_",
          "$(echo PWNED)",
          "${CLAUDE_PROJECT_DIR}",
          out,
        ],
      },
      HookEventName.PostToolUse,
      baseInput(proj),
    );
    expect(r.exitCode).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(`$(echo PWNED)|${proj}`);
  });

  test("占位符只认白名单，env 缺失保持原样", () => {
    const env = { CLAUDE_PROJECT_DIR: "/p", HOME: "/h" };
    expect(expandPathPlaceholders("${CLAUDE_PROJECT_DIR}/a", env)).toBe("/p/a");
    expect(expandPathPlaceholders("$CLAUDE_PROJECT_DIR/a", env)).toBe("/p/a");
    expect(expandPathPlaceholders("${HOME}/a", env)).toBe("${HOME}/a");
    expect(expandPathPlaceholders("${CLAUDE_PLUGIN_ROOT}/a", env)).toBe("${CLAUDE_PLUGIN_ROOT}/a");
  });
});

describe("stdin 通用字段（HC11）", () => {
  /** 注册一个把 stdin 落盘的 hook，触发事件后读回 */
  async function captureStdin(
    event: HookEventName,
    fire: (sys: HookSystem) => Promise<unknown>,
    setup?: (sys: HookSystem) => void,
  ): Promise<any> {
    const file = join(root, `stdin-${event}-${Math.random()}.json`);
    const sys = new HookSystem();
    sys.initializeFromSources([
      {
        hooks: { [event]: [{ hooks: [{ type: "command", command: `cat > '${file}'` }] }] },
        source: ConfigSource.User,
      },
    ]);
    sys.setSessionId("sess-1");
    setup?.(sys);
    await fire(sys);
    return JSON.parse(readFileSync(file, "utf8"));
  }

  test("permission_mode 取 CC 值，原值进 sid_permission_mode；运行时改写可见", async () => {
    let mode = "always-allow";
    const got = await captureStdin(
      HookEventName.UserPromptSubmit,
      (s) => s.fireUserPromptSubmitEvent("hi"),
      (s) => s.setPermissionModeProvider(() => mode),
    );
    expect(got.permission_mode).toBe("bypassPermissions");
    expect(got.sid_permission_mode).toBe("always-allow");

    mode = "plan";
    const got2 = await captureStdin(
      HookEventName.UserPromptSubmit,
      (s) => s.fireUserPromptSubmitEvent("hi"),
      (s) => s.setPermissionModeProvider(() => mode),
    );
    expect(got2.permission_mode).toBe("plan");
  });

  test("映射表", () => {
    expect(toCcPermissionMode("default")).toBe("default");
    expect(toCcPermissionMode("deny-write")).toBe("default");
    expect(toCcPermissionMode("dangerously-skip-permissions")).toBe("bypassPermissions");
    expect(toCcPermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(toCcPermissionMode("")).toBeUndefined();
  });

  test("transcript_path 按当前 sessionId 计算；prompt_id 每轮一个、同轮共用", async () => {
    const file1 = join(root, "p1.json");
    const file2 = join(root, "p2.json");
    const sys = new HookSystem();
    sys.initializeFromSources([
      {
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: `cat > '${file1}'` }] }],
          Stop: [{ hooks: [{ type: "command", command: `cat > '${file2}'` }] }],
        },
        source: ConfigSource.User,
      },
    ]);
    sys.setSessionId("sess-xyz");
    sys.setTranscriptPathProvider((id) => `/t/${id}.jsonl`);
    await sys.fireUserPromptSubmitEvent("hi");
    await sys.fireStopEvent("done");
    const a = JSON.parse(readFileSync(file1, "utf8"));
    const b = JSON.parse(readFileSync(file2, "utf8"));
    expect(a.transcript_path).toBe("/t/sess-xyz.jsonl");
    expect(a.prompt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.prompt_id).toBe(a.prompt_id);

    await sys.fireUserPromptSubmitEvent("again");
    expect(JSON.parse(readFileSync(file1, "utf8")).prompt_id).not.toBe(a.prompt_id);
  });
});

describe("事件专属字段（HC12）", () => {
  test("Stop：last_assistant_message + stop_hook_active", async () => {
    const file = join(root, "stop.json");
    const sys = new HookSystem();
    sys.initializeFromSources([
      {
        hooks: { Stop: [{ hooks: [{ type: "command", command: `cat > '${file}'` }] }] },
        source: ConfigSource.User,
      },
    ]);
    await sys.fireStopEvent("答复", false);
    let got = JSON.parse(readFileSync(file, "utf8"));
    expect(got.last_assistant_message).toBe("答复");
    expect(got.assistant_response).toBe("答复"); // 旧字段保留
    expect(got.stop_hook_active).toBe(false);
    await sys.fireStopEvent("答复2", true);
    got = JSON.parse(readFileSync(file, "utf8"));
    expect(got.stop_hook_active).toBe(true);
  });

  test("PostToolUseFailure：顶层 error / is_interrupt，tool_response 保留，tool_name 发 CC 名", async () => {
    const file = join(root, "fail.json");
    const sys = new HookSystem();
    sys.initializeFromSources([
      {
        hooks: {
          PostToolUseFailure: [
            { matcher: "Read", hooks: [{ type: "command", command: `cat > '${file}'` }] },
          ],
        },
        source: ConfigSource.User,
      },
    ]);
    await sys.firePostToolUseFailureEvent("read", { file_path: "/nope" }, "ENOENT");
    const got = JSON.parse(readFileSync(file, "utf8"));
    expect(got.error).toBe("ENOENT");
    expect(got.is_interrupt).toBe(false);
    expect(got.tool_response.error).toBe("ENOENT");
    expect(got.tool_name).toBe("Read");
  });
});

describe("缺省超时（Q5 / HC20）", () => {
  const cmd = { type: "command", command: "x" } as const;
  test("按事件取缺省值，显式值优先", () => {
    expect(resolveHookTimeoutMs(cmd, HookEventName.PreToolUse)).toBe(600_000);
    expect(resolveHookTimeoutMs(cmd, HookEventName.UserPromptSubmit)).toBe(30_000);
    expect(resolveHookTimeoutMs(cmd, HookEventName.SessionStart)).toBe(30_000);
    expect(resolveHookTimeoutMs({ ...cmd, timeout: 5 }, HookEventName.SessionStart)).toBe(5_000);
    expect(resolveHookTimeoutMs({ type: "prompt", prompt: "p" }, HookEventName.PreToolUse)).toBe(
      30_000,
    );
  });

  test("SessionEnd 共享预算：缺省 1.5s，显式更长则提高，上限 60s；runtime 不动", () => {
    expect(sessionEndBudgetMs([cmd])).toBe(1500);
    expect(sessionEndBudgetMs([cmd, { ...cmd, timeout: 10 }])).toBe(10_000);
    expect(sessionEndBudgetMs([{ ...cmd, timeout: 600 }])).toBe(60_000);
    const rt = { type: "runtime", name: "trace", action: async () => {} } as any;
    const out = applySessionEndBudget([cmd, rt]);
    expect(resolveHookTimeoutMs(out[0]!, HookEventName.SessionEnd)).toBe(1500);
    expect(out[1]).toBe(rt);
  });

  test("实测：SessionEnd 上睡 5s 的 hook 被 1.5s 预算掐掉", async () => {
    const sys = new HookSystem();
    sys.initializeFromSources([
      {
        hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "sleep 5" }] }] },
        source: ConfigSource.User,
      },
    ]);
    sys.setSessionId("se");
    const t0 = Date.now();
    await sys.fireSessionEndEvent("exit");
    expect(Date.now() - t0).toBeLessThan(4000);
  }, 10_000);
});
