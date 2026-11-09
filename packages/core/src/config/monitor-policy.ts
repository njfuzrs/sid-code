/**
 * `settings.monitor.*` 的收紧语义（方案 §5.4.5 / §10.6 / FIX-7）
 *
 * ## 为什么单独一个模块
 *
 * `monitor` 是一类新的长时间运行 shell：每个 monitor 都可能常驻 + 持续叫醒主循环。
 * 企业需要在**不禁用整个 bash** 的前提下收口它（`settings.monitor.enabled=false`），
 * 并能把并发 / 期限调得比内置默认更紧。这个文件是**唯一的读取口**——
 * 工具层（`tool/monitor.ts` 的 `isEnabled` / 入参钳制）与任务层
 * （`task/monitor-task.ts` 的有效上限）都调它，避免两处各写一份合并规则。
 *
 * ## 为什么不用 `getSettings()` 一把梭
 *
 * settings 合并链是「后者覆盖前者」：`policySettings`（企业）排在最后，会直接盖掉
 * 用户级 / 项目级的值。用合并结果做收紧会丢用户自己的收紧值——企业写
 * `maxConcurrent: 99`（显式允许）时，用户写的 `maxConcurrent: 2` 会被盖成 99，
 * 再与代码常量取 min 得到 4，用户的 2 被静默放宽。
 *
 * 所以这里**逐来源读原始值再取 min / &&**：
 * - `maxConcurrent` / `maxTimeoutMs`：所有来源里的合法值取 `Math.min`；
 * - `enabled`：任一来源显式写 `false` 即 `false`（缺省 `true`）。
 *
 * 与代码常量的 `min` 不在这里做——那是 `task/monitor-task.ts` 的职责（常量是默认值），
 * 本模块只负责跨来源收敛，避免 config 反向依赖 task 造成循环。
 */

import { getEnabledSettingSources, getSettingsForSource } from "./settings/settings.ts";

/** 收敛后的 monitor 策略（数值已跨来源取 min，但**未**与代码常量取 min） */
export interface MonitorPolicySettings {
  /** 所有来源都没有显式关闭时为 true */
  enabled: boolean;
  /** 各来源 `maxConcurrent` 的最小合法正整数；都未配时为 undefined */
  maxConcurrent?: number;
  /** 各来源 `maxTimeoutMs` 的最小合法正整数；都未配时为 undefined */
  maxTimeoutMs?: number;
}

/** 只认正数：0 / 负数 / 非有限数都不是有意义的收紧值，忽略（schema 侧也会拒绝） */
function tightestNumber(current: number | undefined, value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return current;
  const normalized = Math.floor(value);
  if (normalized <= 0) return current;
  return current === undefined ? normalized : Math.min(current, normalized);
}

/**
 * 读取当前生效的 monitor 策略。
 *
 * 遍历 `getEnabledSettingSources()`（受 `--setting-sources` 过滤，但 flag /
 * 企业策略始终保留），每个来源只看 `settings.monitor`。函数本身不缓存——
 * 底层 `getSettingsForSource` 有 L2 内存缓存，重复调用是 Map 查表级别；
 * 而调用点（工具列表构建 / 单次 monitor 启动）都不是热路径。
 */
export function getMonitorPolicySettings(): MonitorPolicySettings {
  let enabled = true;
  let maxConcurrent: number | undefined;
  let maxTimeoutMs: number | undefined;

  for (const source of getEnabledSettingSources()) {
    const monitor = getSettingsForSource(source).settings?.monitor;
    if (!monitor) continue;
    if (monitor.enabled === false) enabled = false;
    maxConcurrent = tightestNumber(maxConcurrent, monitor.maxConcurrent);
    maxTimeoutMs = tightestNumber(maxTimeoutMs, monitor.maxTimeoutMs);
  }

  return { enabled, maxConcurrent, maxTimeoutMs };
}
