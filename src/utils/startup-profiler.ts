/**
 * 启动性能剖析系统
 * ⚠️ 极轻量模块——必须是第一个被 import 的，自身加载时间影响测量精度
 *
 * 通过 SID_CODE_PROFILE_STARTUP=1 或 DEBUG=1 启用
 * 非 enabled 模式下所有操作为空操作，零开销
 */

const enabled =
  process.env.SID_CODE_PROFILE_STARTUP === "1" ||
  process.env.DEBUG === "1";

interface Checkpoint {
  name: string;
  timestamp: number; // performance.now()
}

const checkpoints: Checkpoint[] = [];
const startTime = performance.now();

/**
 * 记录一个启动阶段打点
 * 非 enabled 模式下为空操作，零开销
 */
export function profileCheckpoint(name: string): void {
  if (!enabled) return;
  checkpoints.push({ name, timestamp: performance.now() });
}

/** 预定义的阶段区间，用于计算阶段耗时 */
const PHASE_DEFINITIONS: Record<string, [string, string]> = {
  bootstrap_routing: ["bootstrap_entry", "bootstrap_route_resolved"],
  module_loading: ["full_cli_entry", "full_cli_imports_loaded"],
  config_loading: ["config_load_start", "config_load_end"],
  init_sequence: ["init_start", "init_end"],
  tool_registration: ["tool_reg_start", "tool_reg_end"],
  first_render: ["render_start", "render_complete"],
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
