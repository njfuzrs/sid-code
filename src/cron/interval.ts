/**
 * 间隔字符串 → cron 表达式转换（缺口 A：/loop 固定间隔糖衣）
 *
 * 把人类友好的间隔（5m / 30s / 1h / 2h30m）转成标准 5 字段 cron。
 * 仅支持「整除 60 的分钟」「整除 24 的小时」这类能被 cron 精确表达的间隔；
 * 不规则间隔（如 7m、90m）无法用纯 cron 周期表达，返回 null，由调用方降级处理。
 */

export interface IntervalParseResult {
  /** 对应的 cron 表达式 */
  cron: string;
  /** 归一化后的总秒数（用于展示/校验） */
  totalSeconds: number;
}

/** 解析间隔串为总秒数，无法解析返回 null */
export function parseIntervalToSeconds(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;

  // 纯数字默认按分钟（对齐 cc /loop 5 == 5m 的直觉）
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return n > 0 ? n * 60 : null;
  }

  // 组合单位：1h30m / 2h / 45m / 90s
  const re = /(\d+)\s*(h|m|s)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const value = parseInt(m[1], 10);
    const unit = m[2];
    if (unit === "h") total += value * 3600;
    else if (unit === "m") total += value * 60;
    else total += value;
  }
  // 确保整串都被单位 token 覆盖（拒绝 "5x" / "abc" 这类残留）
  if (!matched) return null;
  const stripped = s.replace(/(\d+)\s*(h|m|s)/g, "").trim();
  if (stripped.length > 0) return null;

  return total > 0 ? total : null;
}

/**
 * 间隔串 → cron 表达式。
 * 仅当间隔能被 cron 周期精确表达时返回；否则返回 null。
 *
 * 可表达的情形：
 * - N 秒，且 N 能整除 60 → 退化为按分钟（cron 最小粒度是分钟，秒级不支持，向上取整到 1 分钟）
 * - N 分钟，且 N 能整除 60 → 分字段 * /N
 * - N 小时，且 N 能整除 24 → 时字段 * /N，分字段固定 0
 */
export function intervalToCron(input: string): IntervalParseResult | null {
  const totalSeconds = parseIntervalToSeconds(input);
  if (totalSeconds === null) return null;

  // cron 最小粒度是分钟：不足 1 分钟向上取整到 1 分钟
  const totalMinutes = Math.max(1, Math.round(totalSeconds / 60));

  // < 60 分钟：必须能整除 60，否则周期会在每小时边界错位
  if (totalMinutes < 60) {
    if (60 % totalMinutes !== 0) return null;
    return { cron: `*/${totalMinutes} * * * *`, totalSeconds };
  }

  // 整小时：必须能整除 24
  if (totalMinutes % 60 === 0) {
    const hours = totalMinutes / 60;
    if (hours <= 24 && 24 % hours === 0) {
      return { cron: `0 */${hours} * * *`, totalSeconds };
    }
  }

  return null;
}
