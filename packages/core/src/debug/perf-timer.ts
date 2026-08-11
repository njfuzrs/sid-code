/**
 * 性能计时器
 * 追踪关键操作耗时，定位性能瓶颈
 */

import { getLogger } from './logger.ts';

export interface PerfTimerHandle {
  /** 结束计时，返回耗时毫秒数 */
  end(details?: Record<string, string | number>): number;
}

export interface PerfPhase {
  name: string;
  durationMs: number;
  cpuUserUs: number;
  cpuSystemUs: number;
  details?: Record<string, string | number>;
  timestamp: number;
}

export class PerfTimer {
  private phases: Map<string, PerfPhase> = new Map();

  /**
   * 开始计时
   * @param name 阶段名称，如 "startup", "llm_request", "tool_bash"
   */
  start(name: string): PerfTimerHandle {
    const startTime = performance.now();
    const startCpu = process.cpuUsage();

    return {
      end: (details) => {
        const duration = performance.now() - startTime;
        const cpuUsage = process.cpuUsage(startCpu);

        this.phases.set(name, {
          name,
          durationMs: Math.round(duration * 100) / 100,
          cpuUserUs: cpuUsage.user,
          cpuSystemUs: cpuUsage.system,
          details,
          timestamp: Date.now(),
        });

        // 同时写入日志
        getLogger().debug('PERF', `${name} ${duration.toFixed(1)}ms`, details);
        return duration;
      },
    };
  }

  /** 获取所有已记录的阶段 */
  getPhases(): PerfPhase[] {
    return Array.from(this.phases.values());
  }

  /** 获取指定阶段的耗时 */
  getDuration(name: string): number | undefined {
    return this.phases.get(name)?.durationMs;
  }

  /** 生成性能报告摘要 */
  getSummary(): string {
    const phases = this.getPhases()
      .sort((a, b) => b.durationMs - a.durationMs);

    if (phases.length === 0) return '无性能数据';

    return phases
      .map(p => `  ${p.name}: ${p.durationMs.toFixed(1)}ms`)
      .join('\n');
  }

  clear(): void {
    this.phases.clear();
  }
}

// 全局单例
let globalTimer: PerfTimer | null = null;

export function getPerfTimer(): PerfTimer {
  if (!globalTimer) globalTimer = new PerfTimer();
  return globalTimer;
}
