/**
 * 反死线门禁：触发类事件「常量定义了、emit 写了、接线漏了」必须变红（观测缺口方案 T5）
 *
 * ## 防的是什么
 *
 * 这类埋点有三个独立环节：① 事件名常量（单一事实源）；② 生产侧 emit 调用；
 * ③ app 层把 sink 接到 collector。三者**任何一种缺失都不会被其它测试发现**：
 * 单测直接注入 sink，产品里漏接线照样全绿；接线写了、emit 删了也只有人工读代码能看出来。
 * 实测过的形态就是「sink 定义了、emit 写了、接线漏了」——绿测零调用。
 *
 * ## 为什么读源码而不是跑行为
 *
 * 接线发生在 `App.runBridge` 内部（要跑通整条内核 + 真实 WebSocket 才能观察），
 * 行为测试成本远高于收益。这里用静态断言 + 变异自证兜住形态：删掉任一条接线，
 * 本文件的断言必须变红（见 Agent Note 的验证记录）。
 *
 * ## 断言读代码、不读注释
 *
 * 源码注释里大量提到 `BRIDGE_SESSION_EVENT_NAME` 等名字（解释为什么这么写），
 * 直接 `toContain` 会让「emit 调用被删掉」仍然通过。所以先剥注释再断言。
 *
 * ## 覆盖范围
 *
 * 四组：bridge（T4）/ hook / 回滚 / 定时触发。新增一组时按同样形态往这里加 describe。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../../..");
const SRC_ROOTS = [join(REPO_ROOT, "packages/core/src"), join(REPO_ROOT, "packages/cli/src")];

/**
 * 去掉 `//` 与块注释，保留字符串与代码。
 *
 * 只处理本仓常见的两种注释形态；字符串里出现 `//`（URL）用「前面不是冒号」
 * 的近似条件避开——目标是消掉注释噪声，不是写一个完整的 JS 词法分析器。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 递归收集 src 下的 .ts 生产源码（排除测试文件——测试里的调用点不算生产路径） */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectSources(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const SOURCES = SRC_ROOTS.flatMap((root) => collectSources(root));

/** 返回包含 needle 的文件（已剥注释）。用相对路径输出，失败时能直接定位 */
function callSites(needle: string): string[] {
  return SOURCES.filter((f) => stripComments(readFileSync(f, "utf8")).includes(needle)).map((f) =>
    f.replace(`${REPO_ROOT}/`, ""),
  );
}

/** 读单个生产源码（已剥注释）。路径相对仓库根，失败时能直接定位 */
function readSource(rel: string): string {
  return stripComments(readFileSync(join(REPO_ROOT, rel), "utf8"));
}

/** 生产侧 emit：`emitBridgeTelemetry(<sink>, BRIDGE_X_EVENT_NAME, ...)` */
function emitPattern(sinkExpr: string, constName: string): RegExp {
  return new RegExp(`emitBridgeTelemetry\\(\\s*${sinkExpr}\\s*,\\s*${constName}\\b`);
}

describe("触发事件反死线门禁 · bridge（T4）", () => {
  test("三个事件名常量在单一事实源里定义", () => {
    const telemetry = readSource("packages/core/src/bridge/bridge-telemetry.ts");
    expect(telemetry).toContain('BRIDGE_SESSION_EVENT_NAME = "BridgeSession"');
    expect(telemetry).toContain('BRIDGE_INBOUND_EVENT_NAME = "BridgeInbound"');
    expect(telemetry).toContain('BRIDGE_PERMISSION_EVENT_NAME = "BridgePermission"');
  });

  test("生产侧 emit 调用点都在非注释代码里（生命周期每个阶段各一处）", () => {
    const runner = readSource("packages/core/src/bridge/bridge-runner.ts");
    const core = readSource("packages/core/src/bridge/bridge-core.ts");
    const proxy = readSource("packages/core/src/bridge/permission-proxy.ts");

    // 只断言「至少一处」的话，删掉 connected（连上）或 stopped（收尾）仍然会绿 ——
    // 而「接线漏一条」正是这类门禁要防的形态（实测：删掉 connected 的 emit 后
    // 旧断言照样通过）。三处 = connected + 永久失败（按时机传 phase）+ stopped。
    //
    // ⚠️ 这是**棘轮**：将来新增第四个生命周期相位（如 reconnect）时，必须同步更新
    // 这个数字并确认新事件的接线，而不是把断言放宽成「至少一处」。
    const sessionEmits = runner.match(
      /emitBridgeTelemetry\(\s*this\.deps\.onTelemetry,\s*BRIDGE_SESSION_EVENT_NAME\b/g,
    );
    expect(sessionEmits?.length).toBe(3);
    expect(runner).toContain('phase: "connected"');
    expect(runner).toContain('phase: "stopped"');
    // 永久失败那一处按调用时机传 phase：start_failed 与 permanent_failure 都必须在生产侧用到，
    // 否则「启动即被拒」和「连上后被踢」会被记成同一个数。
    expect(runner).toContain('consumePermanentFailure("start_failed")');
    // 只断言 `"permanent_failure"` 字面量存在是不够的：`consumePermanentFailure` 的
    // **默认参数值**本身就满足它——把 waitForPermanentFailure 里的真实调用删掉，
    // 旧断言仍然全绿（实测）。所以断言函数体内确实有取走失败的调用点：
    // 「连上后被踢」这条事件是靠它发出来的。
    expect(runner).toMatch(/waitForPermanentFailure\(\)[\s\S]{0,400}?consumePermanentFailure\(\)/);

    expect(core).toMatch(emitPattern("this\\.onTelemetry", "BRIDGE_INBOUND_EVENT_NAME"));
    expect(proxy).toMatch(emitPattern("this\\.onTelemetry", "BRIDGE_PERMISSION_EVENT_NAME"));
  });

  test("runner 把 sink 透传给 core（core 再传给权限代理）", () => {
    const runner = readSource("packages/core/src/bridge/bridge-runner.ts");
    // 不透传的话：入站消息与权限结果全部静默丢失，而 runner 自己的三个事件仍然正常
    expect(runner).toMatch(/onTelemetry:\s*deps\.onTelemetry/);

    const core = readSource("packages/core/src/bridge/bridge-core.ts");
    expect(core).toMatch(
      /new PermissionProxy\(\s*this\.transport,\s*options\.permissionTimeoutMs,\s*options\.onTelemetry,?\s*\)/,
    );
  });

  test("app 层把桥接事件接到 collector，并置会话标记", () => {
    const app = readSource("packages/cli/src/app.ts");

    // 接线点必须与 recordCustomEvent 在**同一行**：app.ts 里还有别的 onTelemetry
    // 注入（OTel 探针），只断言「文件里出现过 onTelemetry」会被那一处掩盖——
    // bridge 的注入被删掉也照样绿。
    const wiringLines = app.split("\n").filter((line) => line.includes("onTelemetry"));
    expect(wiringLines.some((line) => line.includes("recordCustomEvent"))).toBe(true);

    // 会话标记：没有它「这个会话是不是被遥控的」在 metadata 里查不到
    expect(app).toContain("setBridgeSessionFlag(true)");
  });

  test("collector 构造 metadata 时读会话标记（/clear 重建也走同一处）", () => {
    const collector = readSource("packages/core/src/trace/collector.ts");
    // 只断言 app 设置了标记不够：collector 漏读时标记永远进不了 metadata，
    // 而两者之间没有类型约束，删掉这行不会有任何东西变红。
    expect(collector).toMatch(/isBridgeSession\(\)\s*\?\s*\{\s*bridge:\s*true\s*\}/);
  });
});

describe("触发事件反死线门禁 · hook / 回滚 / 定时触发（T5 前三组）", () => {
  test("HookExecuted 有生产调用点（runner 的 executeHook 唯一咽喉）", () => {
    const sites = callSites("emitHookTrace(HOOK_EXECUTED_EVENT_NAME");
    expect(sites.length).toBeGreaterThan(0);
    // 必须落在 runner 上：挂在调用方会漏掉 streaming / SessionEnd 预算串行两条路径
    expect(sites.some((s) => s.includes("hook/runner.ts"))).toBe(true);
  });

  test("HookAsyncCompleted 有生产调用点（async-registry 的后台完成）", () => {
    const sites = callSites("emitHookTrace(HOOK_ASYNC_COMPLETED_EVENT_NAME");
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.some((s) => s.includes("hook/async-registry.ts"))).toBe(true);
  });

  test("Rewind 在 core 与 CLI 两侧都有调用点", () => {
    // 用 `emitRewind("` 匹配：定义处是 `export function emitRewind(via: ...`，不会被算成调用
    const sites = callSites('emitRewind("');
    expect(sites.some((s) => s.includes("session/rewind-manager.ts"))).toBe(true);
    // 四个入口里至少覆盖命令层（/rewind /undo /restore）
    expect(sites.filter((s) => s.includes("command/commands/")).length).toBeGreaterThanOrEqual(3);
  });

  test("ScheduledFire 有生产调用点（scheduler 的 fireOnce）", () => {
    const sites = callSites("emitScheduledTrace(SCHEDULED_FIRE_EVENT_NAME");
    expect(sites.some((s) => s.includes("cron/scheduler.ts"))).toBe(true);
  });

  test("ScheduledInject 有生产调用点（app 的注入器前）", () => {
    const sites = callSites("emitScheduledTrace(SCHEDULED_INJECT_EVENT_NAME");
    expect(sites.some((s) => s.includes("cli/src/app.ts"))).toBe(true);
  });

  test("app 层三条 sink 接线都在（漏一条 = 那类事件永远是 0 条）", () => {
    const app = readSource("packages/cli/src/app.ts");
    expect(app).toContain("setHookTraceSink(");
    expect(app).toContain("setRewindTraceSink(");
    expect(app).toContain("setScheduledTraceSink(");
  });

  test("digest 复用事件名常量，不写裸字面量（否则改一处、消费侧静默归零）", () => {
    const digest = readSource("packages/core/src/trace/digest.ts");
    expect(digest).toContain("HOOK_EXECUTED_EVENT_NAME");
    expect(digest).toContain("REWIND_EVENT_NAME");
    expect(digest).toContain("SCHEDULED_FIRE_EVENT_NAME");
    expect(digest).not.toContain('"HookExecuted"');
    expect(digest).not.toContain('"Rewind"');
    expect(digest).not.toContain('"ScheduledFire"');
  });
});
