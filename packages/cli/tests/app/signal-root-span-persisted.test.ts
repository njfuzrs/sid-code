/**
 * X1H2 T0 / T1 验收 · 三种退出方式都必须有会话根落盘。
 *
 * 这是「T1 修后验收」的自动化版本（方案 T1 测试清单第 3 条 + T0 的三路复现）。
 * 缺陷现场：信号退出（Ctrl+C / 关终端）时根 span 只在 SessionEnd 里 end()，而队列
 * 只由 5s 定时刷新与 shutdown flush 消费，两条都赶不上 → 根与最后几秒的子 span
 * 随进程消失。10-01 起 498 个有调用的会话里 283 个没有根。
 *
 * 造数据方式（方案 §T5 提到的「永远等不到数据就自己造」同款思路）：
 * 真进程 + 真信号 + 真 jsonl 落盘，不依赖真实模型调用 —— 用 HookSystem 直接 fire
 * 事件序列，验证的是 harness 那一半（信号 → SessionEnd → drain → 落盘）。
 *
 * 变异自证：把 `handleSessionEnd` 里 `onSpanPersisted` 的登记删掉 / 把 app 收尾的
 * `drainTelemetry` 调用删掉，SIGHUP 与 SIGINT 两条必红（exit 路径走 runShutdownSequence
 * 的 flush，可能仍绿 —— 这正是三路要分开测的原因）。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * 落盘隔离：本文件的 `initTelemetry` 只在**子进程脚本**里执行，本进程不落盘；
 * 但哨兵（no-real-path-writes.test.ts）要求「出现落盘类导出名 → 必须真实声明隔离」，
 * 且将来若有人在本进程里加了 initTelemetry，这里也已经是安全的。存/恢复而非 delete
 * （bun test 同批多文件跑在同一进程里）。
 */
const prevSidConfigDir = process.env.SID_CONFIG_DIR;
let isolationHome = "";
beforeAll(() => {
  isolationHome = mkdtempSync(join(tmpdir(), "sid-root-span-isolation-"));
  process.env.SID_CONFIG_DIR = isolationHome;
});
afterAll(() => {
  if (prevSidConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevSidConfigDir;
  rmSync(isolationHome, { recursive: true, force: true });
});

const SIGNAL_TEARDOWN_TS = join(import.meta.dir, "../../src/signal-teardown.ts");
const HOOK_SYSTEM_TS = join(import.meta.dir, "../../../core/src/hook/system.ts");
const HOOK_PROBE_TS = join(import.meta.dir, "../../../core/src/telemetry/hook-probe.ts");
const TELEMETRY_INDEX_TS = join(import.meta.dir, "../../../core/src/telemetry/index.ts");

type Mode = "SIGHUP" | "SIGINT" | "exit";

/**
 * 子进程脚本：模拟一次会话（SessionStart → 工具 → 退出）。
 *
 * `mode=exit` 走正常收尾（等价于用户输入 /exit）；SIGHUP / SIGINT 等父进程发信号。
 * 两条路径都复用真实 `installTeardownSignalHandlers` + `telemetryDrainBudgetMs` +
 * `drainTelemetry`，与 app.ts 的收尾序列同源。
 */
function buildScript(mode: Mode, traceDir: string): string {
  return `
    const { installTeardownSignalHandlers, telemetryDrainBudgetMs, SIGNAL_FORCE_EXIT_MS } =
      await import(${JSON.stringify(SIGNAL_TEARDOWN_TS)});
    const { HookSystem } = await import(${JSON.stringify(HOOK_SYSTEM_TS)});
    const { TelemetryHookProbe } = await import(${JSON.stringify(HOOK_PROBE_TS)});
    const { initTelemetry, drainTelemetry } = await import(${JSON.stringify(TELEMETRY_INDEX_TS)});

    const bus = initTelemetry({
      enabled: true,
      exporters: [{ type: "jsonl", options: { outputDir: ${JSON.stringify(traceDir)} } }],
      flushIntervalMs: 999999,
      batchSize: 512,
    });
    const probe = new TelemetryHookProbe(bus, null, {
      model: "e2e-model",
      provider: "e2e-provider",
      sessionId: "e2e-${mode}",
    });
    const hookSystem = new HookSystem();
    probe.registerHooks(hookSystem);

    await hookSystem.fireSessionStartEvent("startup", { model: "e2e-model" });
    await hookSystem.firePreToolUseEvent("read", { file_path: "/x" }, "tu-1");
    await hookSystem.firePostToolUseEvent(
      "read", { file_path: "/x" }, { output: "ok" }, false, "tu-1", { duration_ms: 5 },
    );

    const start = Date.now();
    let finished = false;
    const finish = async (reason, code) => {
      if (finished) return;
      finished = true;
      await hookSystem.fireSessionEndEvent(reason, {
        total_cost_usd: 0,
        total_tokens_sent: 0,
        total_tokens_received: 0,
      });
      const budget = telemetryDrainBudgetMs(Date.now() - start);
      if (budget > 0) await drainTelemetry(budget);
      process.exit(code);
    };

    if (${JSON.stringify(mode)} === "exit") {
      // 正常退出：不等信号，直接走收尾（等价 /exit）
      await finish("exit", 0);
    } else {
      installTeardownSignalHandlers({
        run: async (signal) => {
          await finish("other", 128 + (signal === "SIGHUP" ? 1 : 2));
        },
        forceExit: () => process.exit(137),
      });
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1000);
    }
  `;
}

describe("X1H2 T0/T1 · 三路退出都有根落盘", () => {
  const modes: Mode[] = ["SIGHUP", "SIGINT", "exit"];

  for (const mode of modes) {
    test(`${mode} 退出后 traces.jsonl 里有会话根，且工具 span 挂在其下`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `sid-root-${mode}-`));
      const proc = Bun.spawn(["bun", "-e", buildScript(mode, dir)], {
        env: {
          ...process.env,
          // 子进程不继承进程内的 env 改动，必须显式传（CONTRIBUTING.md 测试隔离约定）
          SID_CONFIG_DIR: dir,
          SID_CODE_CACHE_BREAKS: dir,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      try {
        if (mode !== "exit") {
          // 等脚本把 hook 装好再发信号，避免信号打在 ready 之前
          const reader = proc.stdout.getReader();
          const dec = new TextDecoder();
          let out = "";
          while (!out.includes("ready")) {
            const { value, done } = await reader.read();
            if (done) break;
            out += dec.decode(value);
          }
          expect(out).toContain("ready");
          proc.kill(mode);
        }

        const code = await proc.exited;
        // SIGHUP/SIGINT 走 128+n；exit 走 0；forceExit 才是异常 137
        expect(code).not.toBe(137);

        const spanFile = join(dir, "traces.jsonl");
        expect(existsSync(spanFile)).toBe(true);
        const spans = readFileSync(spanFile, "utf8")
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l));

        const root = spans.find(
          (s) => s.kind === "invoke_agent" && !s.parentSpanId && s.name === "invoke_agent sid-code",
        );
        expect(root).toBeDefined();
        expect(root.attributes["gen_ai.conversation.id"]).toBe(`e2e-${mode}`);

        // 工具 span 也在，且父是根（不是悬空）——T1 只保证根落盘，T2 保证工具挂对
        const tool = spans.find((s) => s.kind === "execute_tool");
        expect(tool).toBeDefined();
        expect(tool.parentSpanId).toBe(root.spanId);
      } finally {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);
  }
});
