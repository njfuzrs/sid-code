/**
 * Cron 表达式解析器（Spec 18 §5.3.4）
 *
 * 自实现标准 5 字段解析（分 时 日 月 周），不引入外部依赖。
 * 支持：* / 数字 / a-b 范围 / a,b,c 列表 / * /n 步长。
 * 周字段：0-6（0=周日），也接受 7=周日。
 *
 * 同时提供确定性抖动（jitter）：基于 taskId 哈希，避免全球用户在整点同时触发。
 */

interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

/** 解析单个字段为允许值集合 */
function parseField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();

  for (const part of field.split(",")) {
    // 步长 a/n 或 */n 或 a-b/n
    let step = 1;
    let rangeStr = part;
    const slashIdx = part.indexOf("/");
    if (slashIdx !== -1) {
      step = parseInt(part.slice(slashIdx + 1), 10);
      rangeStr = part.slice(0, slashIdx);
      if (Number.isNaN(step) || step <= 0) {
        throw new Error(`无效步长: ${part}`);
      }
    }

    let lo: number;
    let hi: number;
    if (rangeStr === "*") {
      lo = min;
      hi = max;
    } else if (rangeStr.includes("-")) {
      const [a, b] = rangeStr.split("-");
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
    } else {
      lo = parseInt(rangeStr, 10);
      hi = lo;
    }

    if (Number.isNaN(lo) || Number.isNaN(hi)) {
      throw new Error(`无效字段: ${part}`);
    }

    for (let v = lo; v <= hi; v += step) {
      if (v < min || v > max) continue;
      result.add(v);
    }
  }

  if (result.size === 0) {
    throw new Error(`字段无匹配值: ${field}`);
  }
  return result;
}

/** 解析完整 cron 表达式 */
export function parseCron(cronExpr: string): ParsedCron {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron 表达式必须是 5 个字段，收到 ${fields.length} 个: "${cronExpr}"`);
  }

  const [min, hour, dom, mon, dow] = fields;
  const daysOfWeek = parseField(dow, 0, 7);
  // 归一化：7 → 0（都表示周日）
  if (daysOfWeek.has(7)) {
    daysOfWeek.add(0);
    daysOfWeek.delete(7);
  }

  return {
    minutes: parseField(min, 0, 59),
    hours: parseField(hour, 0, 23),
    daysOfMonth: parseField(dom, 1, 31),
    months: parseField(mon, 1, 12),
    daysOfWeek,
  };
}

/** 校验 cron 表达式是否合法 */
export function isValidCron(cronExpr: string): boolean {
  try {
    parseCron(cronExpr);
    return true;
  } catch {
    return false;
  }
}

/**
 * 计算下一个 cron 匹配时间。
 * 从 fromMs 之后的下一分钟开始逐分钟扫描，最多扫 4 年（覆盖闰年 2/29）。
 * 返回毫秒时间戳，无匹配返回 null。
 */
export function computeNextCronRun(cronExpr: string, fromMs: number): number | null {
  let parsed: ParsedCron;
  try {
    parsed = parseCron(cronExpr);
  } catch {
    return null;
  }

  // 标准 cron：日和周字段都非通配时取"或"语义（任一匹配即可）
  const domRestricted = !isWildcard(cronExpr, 2);
  const dowRestricted = !isWildcard(cronExpr, 4);

  // 从下一分钟开始（对齐到分钟边界，秒清零）
  const start = new Date(fromMs);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const maxMinutes = 4 * 366 * 24 * 60; // 约 4 年
  const cursor = new Date(start);

  for (let i = 0; i < maxMinutes; i++) {
    const matchMin = parsed.minutes.has(cursor.getMinutes());
    const matchHour = parsed.hours.has(cursor.getHours());
    const matchMon = parsed.months.has(cursor.getMonth() + 1);
    const matchDom = parsed.daysOfMonth.has(cursor.getDate());
    const matchDow = parsed.daysOfWeek.has(cursor.getDay());

    // 日/周匹配规则
    let dayMatch: boolean;
    if (domRestricted && dowRestricted) {
      dayMatch = matchDom || matchDow; // 标准"或"语义
    } else if (domRestricted) {
      dayMatch = matchDom;
    } else if (dowRestricted) {
      dayMatch = matchDow;
    } else {
      dayMatch = true; // 都是通配
    }

    if (matchMin && matchHour && matchMon && dayMatch) {
      return cursor.getTime();
    }

    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  return null;
}

/** 判断 cron 第 idx 个字段是否为通配符 * */
function isWildcard(cronExpr: string, idx: number): boolean {
  const field = cronExpr.trim().split(/\s+/)[idx];
  return field === "*";
}

/**
 * 计算 (fromMs, untilMs] 区间内所有应触发的时刻（升序）。
 * 缺口 C1 catch-up：守护进程停机后重启，用本函数枚举错过的触发点。
 * 上限 maxRuns 防止超长停机（如几年）枚举爆炸——只关心最近一次，取尾即可。
 */
export function computeMissedRuns(
  cronExpr: string,
  fromMs: number,
  untilMs: number,
  maxRuns = 10_000,
): number[] {
  const runs: number[] = [];
  if (untilMs <= fromMs) return runs;
  let cursor = fromMs;
  for (let i = 0; i < maxRuns; i++) {
    const next = computeNextCronRun(cronExpr, cursor);
    if (next === null || next > untilMs) break;
    runs.push(next);
    cursor = next;
  }
  return runs;
}

/**
 * 计算「只补最近一次」的 catch-up 时刻（对齐 cc Desktop「discards anything older」）。
 * 返回 (fromMs, untilMs] 区间内最后一个应触发时刻；无错过返回 null。
 * 日任务睡 6 天醒来只补 1 次——丢弃更早的所有错过时刻。
 */
export function computeLatestMissedRun(
  cronExpr: string,
  fromMs: number,
  untilMs: number,
): number | null {
  const missed = computeMissedRuns(cronExpr, fromMs, untilMs);
  return missed.length > 0 ? missed[missed.length - 1] : null;
}

/** 字符串稳定哈希（FNV-1a 变体），用于确定性抖动 */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 带确定性抖动的下一次触发时间。
 * 抖动量基于 taskId 哈希，循环任务最多偏移周期的 10%（上限 15 分钟），
 * 避免全球用户在同一整点瞬间触发。
 */
export function jitteredNextFireMs(
  cronExpr: string,
  fromMs: number,
  taskId: string,
): number | null {
  const next = computeNextCronRun(cronExpr, fromMs);
  if (next === null) return null;

  // 用 taskId 哈希生成 [0, 1) 的确定性抖动因子
  const factor = hashString(taskId) / 0xffffffff;

  // 周期估算：下一次与再下一次的间隔
  const nextNext = computeNextCronRun(cronExpr, next);
  const periodMs = nextNext !== null ? nextNext - next : 60_000;

  // 抖动上限：周期的 10%，但不超过 15 分钟
  const maxJitter = Math.min(periodMs * 0.1, 15 * 60_000);
  const jitter = Math.floor(factor * maxJitter);

  return next + jitter;
}
