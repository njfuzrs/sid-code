/**
 * 启动性能剖析系统
 * ⚠️ 极轻量模块——必须是第一个被 import 的，自身加载时间影响测量精度
 *
 * 通过 SID_CODE_PROFILE_STARTUP=1 或 DEBUG=1 启用
 * 非 enabled 模式下所有操作为空操作，零开销
 */

const enabled = process.env.SID_CODE_PROFILE_STARTUP === "1" || process.env.DEBUG === "1";

interface Checkpoint {
  name: string;
  timestamp: number; // performance.now()
}

const checkpoints: Checkpoint[] = [];
const startTime = performance.now();

/**
 * 首帧后继续观测事件循环阻塞的时长（ms）。
 * 口径「首帧前后 3s」：fire-and-forget 的启动维护任务恰好落在首帧之后，
 * 只看到首帧为止会把「界面出来了、打字没反应」那一段漏掉（10-30 实测 54s 阻塞就在首帧后）。
 */
const LOOP_BLOCK_WINDOW_AFTER_FIRST_FRAME_MS = 3000;
/** 探针采样间隔。阻塞时长 = 两次回调的实际间隔 − 采样间隔 */
const LOOP_PROBE_INTERVAL_MS = 10;

/** 派生口径（不是时间点，单独存放，避免和 checkpoints 混在一条时间线上） */
const metrics: Record<string, number> = {};

let loopProbe: ReturnType<typeof setInterval> | null = null;
let loopProbeLast = 0;
let loopProbeMax = 0;
let loopProbeDeadline = Number.POSITIVE_INFINITY;

/**
 * 记录一个启动阶段打点
 * 非 enabled 模式下为空操作，零开销
 */
export function profileCheckpoint(name: string): void {
  if (!enabled) return;
  checkpoints.push({ name, timestamp: performance.now() });
  if (name === "first_frame" && loopProbe) {
    loopProbeDeadline = performance.now() + LOOP_BLOCK_WINDOW_AFTER_FIRST_FRAME_MS;
  }
}

/**
 * 启动事件循环阻塞探针：从调用时刻（bootstrap_entry）到首帧后 3s，
 * 记录 setInterval 漂移的最大值，写进 `max_loop_block_before_interactive`。
 *
 * 为什么需要它（G1）：原有打点只覆盖 init 段（< 0.4s），`render_complete` 打在
 * effect 里会被阻塞一起拖晚，于是「补传 gzipSync 445MB 占住主线程 3s」这类
 * fire-and-forget 造成的阻塞在报告里完全不可见——那次 20s 启动正是这样一直没被发现的。
 *
 * 只在开启 profiling 时生效；`unref` 不拖住进程退出。
 */
export function startLoopBlockProbe(): void {
  if (!enabled || loopProbe) return;
  loopProbeLast = performance.now();
  loopProbe = setInterval(() => {
    const now = performance.now();
    const block = now - loopProbeLast - LOOP_PROBE_INTERVAL_MS;
    if (block > loopProbeMax) loopProbeMax = block;
    loopProbeLast = now;
    if (now >= loopProbeDeadline) {
      clearInterval(loopProbe!);
      loopProbe = null;
      finishLoopBlockProbe();
    }
  }, LOOP_PROBE_INTERVAL_MS);
  (loopProbe as { unref?: () => void }).unref?.();
}

function finishLoopBlockProbe(): void {
  metrics.max_loop_block_before_interactive = Math.max(0, Math.round(loopProbeMax));
  dumpProfile();
}

/**
 * `SID_CODE_PROFILE_STARTUP_DUMP=<path>` 时把打点 + 派生口径写成 JSON。
 *
 * 为什么要落文件：TUI 用 Ctrl+C / kill 退出时 exit 报告打印不出来（终端已被 ink 占着），
 * e2e 门禁和人工复测都需要一个不依赖退出路径的取数源。窗口结束时写一次。
 */
function dumpProfile(): void {
  const path = process.env.SID_CODE_PROFILE_STARTUP_DUMP;
  if (!path) return;
  try {
    // 动态 require：本模块必须保持零静态依赖（它是第一个被 import 的）
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(
      path,
      JSON.stringify({
        checkpoints: checkpoints.map((c) => ({
          name: c.name,
          ms: Math.round((c.timestamp - startTime) * 10) / 10,
        })),
        metrics,
      }),
    );
  } catch {
    /* 剖析是诊断手段，写失败不影响启动 */
  }
}

/** 派生口径快照（供调试 / 测试） */
export function getProfileMetrics(): Readonly<Record<string, number>> {
  return metrics;
}

/** 预定义的阶段区间，用于计算阶段耗时 */
const PHASE_DEFINITIONS: Record<string, [string, string]> = {
  bootstrap_routing: ["bootstrap_entry", "bootstrap_route_resolved"],
  module_loading: ["full_cli_entry", "full_cli_imports_loaded"],
  config_loading: ["config_load_start", "config_load_end"],
  init_sequence: ["init_start", "init_end"],
  tool_registration: ["tool_reg_start", "tool_reg_end"],
  first_render: ["render_start", "render_complete"],
  // first_frame：ink 第一次写 stdout 的时刻，即用户「看见界面」。render_complete 打在
  // effect 里，会被主线程阻塞拖晚，两者不是一回事（G1）。
  time_to_first_frame: ["bootstrap_entry", "first_frame"],
  total_startup: ["bootstrap_entry", "render_complete"],
};

/** 生成启动性能报告 */
export function profileReport(): string {
  if (!enabled || checkpoints.length === 0) return "";

  const lines: string[] = ["=== 启动性能报告 ==="];

  // 时间线
  for (const cp of checkpoints) {
    const elapsed = (cp.timestamp - startTime).toFixed(1);
    lines.push(`  ${elapsed}ms  ${cp.name}`);
  }

  // 阶段耗时
  lines.push("\n--- 阶段耗时 ---");
  for (const [phase, [start, end]] of Object.entries(PHASE_DEFINITIONS)) {
    const s = checkpoints.find((c) => c.name === start);
    const e = checkpoints.find((c) => c.name === end);
    if (s && e) {
      const duration = (e.timestamp - s.timestamp).toFixed(1);
      lines.push(`  ${phase}: ${duration}ms`);
    }
  }

  const metricEntries = Object.entries(metrics);
  if (metricEntries.length > 0) {
    lines.push("\n--- 派生口径 ---");
    for (const [k, v] of metricEntries) lines.push(`  ${k}: ${v}ms`);
  }

  return lines.join("\n");
}

/** 获取所有打点数据（供调试使用） */
export function getCheckpoints(): ReadonlyArray<Readonly<Checkpoint>> {
  return checkpoints;
}

/** 是否启用了启动性能剖析 */
export function isProfilingEnabled(): boolean {
  return enabled;
}
