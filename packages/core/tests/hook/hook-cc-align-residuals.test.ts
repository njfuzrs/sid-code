/**
 * Hook 对齐 CC · 残留回补（2026-10-07 复核 8e463c2f 后发现的缺口）
 *
 * - Q3：父进程的 CLAUDE_* 不透传给 hook
 * - Q5：纯 async 不强制 timeout；asyncRewake 仍强制
 * - HC19：URL hook 非 2xx 是非阻塞错误（不 deny）；形如 JSON 解析失败要告警；非阻塞错误文案对齐 CC
 * - HC20：SessionEnd 串行时共享总预算（按剩余预算扣减，用尽的不执行）
 * - HC12：SessionStart 补 clear / compact，二次触发只跑用户 hook，上下文待下一条消息取走
 * - HC24：ConfigChange changed_keys 由前后快照算出；block 时回退缓存
 */

import { describe, test, expect, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRunner } from "@sid-code/core/hook/runner.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { AsyncHookRegistry } from "@sid-code/core/hook/async-registry.ts";
import { HookEventName, ConfigSource } from "@sid-code/core/hook/types.ts";
import {
  diffTopLevelKeys,
  restoreSourceSnapshot,
  getCachedSource,
  setCachedSource,
  resetSettingsCache,
} from "@sid-code/core/config/settings/cache.ts";

const root = mkdtempSync(join(tmpdir(), "sid-residuals-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const baseInput = (event = "PostToolUse") =>
  ({ session_id: "s", cwd: root, hook_event_name: event, timestamp: "" }) as any;

describe("Q3：父进程 CLAUDE_* 不透传", () => {
  const saved = process.env.CLAUDE_ENV_FILE;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_ENV_FILE;
    else process.env.CLAUDE_ENV_FILE = saved;
  });

  test("宿主里的 CLAUDE_ENV_FILE 不进 hook 环境，CLAUDE_PROJECT_DIR 照常导出", async () => {
    process.env.CLAUDE_ENV_FILE = "/tmp/should-not-leak";
    const runner = new HookRunner();
    runner.setProjectDir(root);
    const r = await runner.executeHook(
      { type: "command", command: "env | grep '^CLAUDE_' | cut -d= -f1 | sort | tr '\\n' ' '" },
      HookEventName.PostToolUse,
      baseInput(),
    );
    const names = (r.output?.systemMessage ?? "").trim().split(" ").filter(Boolean);
    expect(names).toEqual(["CLAUDE_PROJECT_DIR"]);
  });
});

describe("Q5：async 不强制 timeout", () => {
  test("纯 async：超过 timeout 仍跑完、退出码照记", async () => {
    const registry = new AsyncHookRegistry();
    const runner = new HookRunner();
    runner.setAsyncRegistry(registry);
    const r = await runner.executeHook(
      { type: "command", command: "sleep 1.5; exit 3", async: true, timeout: 1 } as any,
      HookEventName.PostToolUse,
      baseInput(),
    );
    expect(r.async).toBe(true);
    await new Promise((res) => setTimeout(res, 2500));
    const entry = [...((registry as any).pending as Map<string, any>).values()][0];
    // 被 SIGTERM 强杀时 exitCode 是 143 / null；跑完是 3
    expect(entry?.exitCode).toBe(3);
  }, 10_000);
});

describe("HC19：URL hook 非 2xx 与 JSON 解析", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterAll(() => server?.stop(true));

  test("非 2xx 不 deny，是非阻塞错误；文案对齐 CC「hook error」", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("upstream down", { status: 502 }) });
    const runner = new HookRunner();
    const r = await runner.executeHook(
      // loopback 由 SSRF 守卫放行（H5）
      {
        type: "url",
        url: `http://127.0.0.1:${server.port}/hook`,
        name: "audit",
      } as any,
      HookEventName.PreToolUse,
      baseInput("PreToolUse"),
    );
    expect(r.output?.decision).toBeUndefined();
    expect(r.success).toBe(false);
    expect(r.output?.systemMessage ?? r.error?.message ?? "").toContain("hook error");
  });

  test("非零非 2 退出码的非阻塞告警文案带 hook error", async () => {
    const runner = new HookRunner();
    const r = await runner.executeHook(
      { type: "command", command: "echo boom >&2; exit 1" },
      HookEventName.PostToolUse,
      baseInput(),
    );
    expect(r.output?.decision).toBeUndefined();
    expect(r.output?.systemMessage).toContain("hook error: boom");
  });
});

describe("HC20：SessionEnd 串行共享总预算", () => {
  test("前一条吃满预算后，后面的用户 hook 不再执行", async () => {
    const hs = new HookSystem();
    hs.initializeFromSources([
      {
        source: ConfigSource.User,
        hooks: {
          SessionEnd: [
            {
              sequential: true,
              hooks: [
                { type: "command", command: "sleep 3" },
                { type: "command", command: `touch ${join(root, "second-ran")}` },
              ],
            },
          ],
        },
      } as any,
    ]);
    const t0 = Date.now();
    const res = await hs.fireSessionEndEvent("exit");
    const elapsed = Date.now() - t0;
    // 预算 1.5s：第一条被截断，第二条预算用尽不执行。原先逐条截断会累计到 ~3s
    expect(elapsed).toBeLessThan(2800);
    expect(await Bun.file(join(root, "second-ran")).exists()).toBe(false);
    expect(res.errors.length + res.allOutputs.length).toBeGreaterThanOrEqual(0);
  }, 10_000);
});

describe("HC12：SessionStart clear / compact", () => {
  test("restart 只跑用户 hook，上下文取一次即清空；matcher 可按 source 过滤", async () => {
    const hs = new HookSystem();
    const runtimeSeen: string[] = [];
    hs.initializeFromSources([
      {
        source: ConfigSource.User,
        hooks: {
          SessionStart: [
            { matcher: "compact", hooks: [{ type: "command", command: "echo after-compact" }] },
            { matcher: "startup", hooks: [{ type: "command", command: "echo only-startup" }] },
          ],
        },
      } as any,
    ]);
    hs.registerHook(
      {
        type: "runtime",
        name: "probe",
        action: async (input: any) => {
          runtimeSeen.push(input.source);
        },
      },
      HookEventName.SessionStart,
      { source: ConfigSource.Runtime },
    );
    await hs.fireSessionRestartEvent("compact");
    expect(hs.takePendingSessionContext()).toBe("after-compact");
    expect(hs.takePendingSessionContext()).toBeUndefined();
    expect(runtimeSeen).toEqual([]);
  });

  test("clear 丢弃 clear 之前未用掉的上下文", async () => {
    const hs = new HookSystem();
    hs.initializeFromSources([
      {
        source: ConfigSource.User,
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: "command", command: 'echo "src=$(cat | grep -o compact || echo clear)"' },
              ],
            },
          ],
        },
      } as any,
    ]);
    await hs.fireSessionRestartEvent("compact");
    await hs.fireSessionRestartEvent("clear");
    expect(hs.takePendingSessionContext()).toBe("src=clear");
  });
});

describe("HC24：ConfigChange 快照", () => {
  afterEach(() => resetSettingsCache());

  test("diffTopLevelKeys 只报真正变化的顶层键", () => {
    expect(
      diffTopLevelKeys(
        { model: "a", env: { X: "1" }, keep: 1 },
        { model: "b", env: { X: "1" }, keep: 1, added: true },
      ),
    ).toEqual(["added", "model"]);
    expect(diffTopLevelKeys(null, { a: 1 })).toEqual(["a"]);
  });

  test("restoreSourceSnapshot 把单来源缓存回退到旧值", () => {
    const old = { settings: { model: "old" } as any, errors: [] };
    setCachedSource("userSettings", { settings: { model: "new" } as any, errors: [] });
    restoreSourceSnapshot("userSettings", old);
    expect(getCachedSource("userSettings")?.settings?.model).toBe("old");
  });
});
