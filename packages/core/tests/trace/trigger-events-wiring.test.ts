/**
 * 观测缺口 PR1：三组触发事件的**反死线门禁**。
 *
 * 防的是「sink 定义了、emit 写了、接线漏了」这种**绿测零调用**的形态：
 * 单测可以自己注入 sink 让 emit 看起来在工作，但生产路径上一个调用点都没有，
 * 轨迹里永远是 0 条——而所有单测照样全绿。
 *
 * 所以这里**读源码**（并剥掉注释，避免注释里提到函数名就算数）断言三件事：
 *   ① 生产侧 emit 函数在非测试源码里至少有一个真实调用点；
 *   ② app 层有对应的 `setXxxSink` 接线；
 *   ③ 消费侧（digest）复用事件名常量而不是写裸字面量——digest 是最容易漏改的消费方。
 *
 * 断言对象是 PR1 的三组：HookExecuted(+HookAsyncCompleted) / Rewind / ScheduledFire。
 * bridge（T4）那组在 PR2 里补，本文件届时加一行配置即可。
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../../..");
const SRC_ROOTS = [join(REPO_ROOT, "packages/core/src"), join(REPO_ROOT, "packages/cli/src")];

/** 递归收集 src 下的 .ts 生产源码（排除测试文件——测试里的调用点不算生产路径） */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectSources(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/**
 * 去掉块注释与行注释。
 * 行注释的正则要求前面不是 `:`，避免把 `https://` 这类字符串拦腰截断；
 * 门禁宁可漏掉一点注释，也不能把真实代码判没。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const SOURCES = SRC_ROOTS.flatMap((root) => collectSources(root));

/** 返回包含 needle 的文件（已剥注释）。用相对路径输出，失败时能直接定位 */
function callSites(needle: string): string[] {
  return SOURCES.filter((f) => stripComments(readFileSync(f, "utf8")).includes(needle)).map((f) =>
    f.replace(`${REPO_ROOT}/`, ""),
  );
}

function readSource(rel: string): string {
  return stripComments(readFileSync(join(REPO_ROOT, rel), "utf8"));
}

describe("触发事件接线门禁（PR1：hook / rewind / scheduled）", () => {
  it("HookExecuted 有生产调用点（runner 的 executeHook 唯一咽喉）", () => {
    const sites = callSites("emitHookTrace(HOOK_EXECUTED_EVENT_NAME");
    expect(sites.length).toBeGreaterThan(0);
    // 必须落在 runner 上：挂在调用方会漏掉 streaming / SessionEnd 预算串行两条路径
    expect(sites.some((s) => s.includes("hook/runner.ts"))).toBe(true);
  });

  it("HookAsyncCompleted 有生产调用点（async-registry 的后台完成）", () => {
    const sites = callSites("emitHookTrace(HOOK_ASYNC_COMPLETED_EVENT_NAME");
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.some((s) => s.includes("hook/async-registry.ts"))).toBe(true);
  });

  it("Rewind 在 core 与 CLI 两侧都有调用点", () => {
    // 用 `emitRewind("` 匹配：定义处是 `export function emitRewind(via: ...`，不会被算成调用
    const sites = callSites('emitRewind("');
    expect(sites.some((s) => s.includes("session/rewind-manager.ts"))).toBe(true);
    // 四个入口里至少覆盖命令层（/rewind /undo /restore）
    expect(sites.filter((s) => s.includes("command/commands/")).length).toBeGreaterThanOrEqual(3);
  });

  it("ScheduledFire 有生产调用点（scheduler 的 fireOnce）", () => {
    const sites = callSites("emitScheduledTrace(SCHEDULED_FIRE_EVENT_NAME");
    expect(sites.some((s) => s.includes("cron/scheduler.ts"))).toBe(true);
  });

  it("ScheduledInject 有生产调用点（app 的注入器前）", () => {
    const sites = callSites("emitScheduledTrace(SCHEDULED_INJECT_EVENT_NAME");
    expect(sites.some((s) => s.includes("cli/src/app.ts"))).toBe(true);
  });

  it("app 层三条 sink 接线都在（漏一条 = 那类事件永远是 0 条）", () => {
    const app = readSource("packages/cli/src/app.ts");
    expect(app).toContain("setHookTraceSink(");
    expect(app).toContain("setRewindTraceSink(");
    expect(app).toContain("setScheduledTraceSink(");
  });

  it("digest 复用事件名常量，不写裸字面量（否则改一处、消费侧静默归零）", () => {
    const digest = readSource("packages/core/src/trace/digest.ts");
    expect(digest).toContain("HOOK_EXECUTED_EVENT_NAME");
    expect(digest).toContain("REWIND_EVENT_NAME");
    expect(digest).toContain("SCHEDULED_FIRE_EVENT_NAME");
    expect(digest).not.toContain('"HookExecuted"');
    expect(digest).not.toContain('"Rewind"');
    expect(digest).not.toContain('"ScheduledFire"');
  });
});
