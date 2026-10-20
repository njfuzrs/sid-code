/**
 * Cron 表达式解析器（Spec 18 §5.3.4）
 *
 * 自实现标准 5 字段解析（分 时 日 月 周），不引入外部依赖。
 * 支持：* / 数字 / a-b 范围 / a,b,c 列表 / * /n、a-b/n、a/n 步长。
 * a/n 按标准 cron（crontab(5)）等价于 a-max/n：`5/10` 在分字段 = 5,15,25,…,55。
 * 任何越界值（单值或范围端点）一律报错，不做静默截断。
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
      // a/n 是 a-max/n（标准 cron）；此前当成单值，`5/10` 只匹配 5，频率差 6 倍且不报错
      hi = slashIdx !== -1 ? max : lo;
    }

    if (Number.isNaN(lo) || Number.isNaN(hi)) {
      throw new Error(`无效字段: ${part}`);
    }
    // 端点越界即报错。此前循环里 `continue` 跳过越界值，只有结果集全空才报错——
    // `1-99` 的周字段因此被静默截成 0-6（每天）。
    if (lo < min || lo > max || hi < min || hi > max) {
      throw new Error(`无效范围: ${part}（允许 ${min}-${max}）`);
    }

    for (let v = lo; v <= hi; v += step) {
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

/** 扫描上限：约 4 年（覆盖闰年 2/29），超过即判「永不触发」 */
const SCAN_HORIZON_MS = 4 * 366 * 24 * 60 * 60_000;

/** 日/周匹配（标准 cron：日和周字段都非通配时取「或」语义） */
function dayMatches(parsed: ParsedCron, cursor: Date, domR: boolean, dowR: boolean): boolean {
  const matchDom = parsed.daysOfMonth.has(cursor.getDate());
  const matchDow = parsed.daysOfWeek.has(cursor.getDay());
  if (domR && dowR) return matchDom || matchDow;
  if (domR) return matchDom;
  if (dowR) return matchDow;
  return true;
}

/**
 * 用本地时间字段移动游标，并保证严格单调。
 * DST 下本地时间的 setter 可能落到不存在/重复的墙钟时刻被引擎消歧（如春季跳时
 * 2:59 被解析成 3:59，方向反了）；一旦没朝期望方向走，退回按绝对毫秒走 1 分钟——
 * 宁可慢，不能原地打转或倒退。
 */
function moveCursor(cursor: Date, dir: 1 | -1, mutate: (d: Date) => void): void {
  const before = cursor.getTime();
  mutate(cursor);
  const after = cursor.getTime();
  if (dir === 1 ? after <= before : after >= before) cursor.setTime(before + dir * 60_000);
}

/**
 * 计算下一个 cron 匹配时间。
 * 从 fromMs 之后的下一分钟开始扫描，最多扫 4 年（覆盖闰年 2/29）。
 * 返回毫秒时间戳，无匹配返回 null。
 *
 * 按「月 → 日 → 时 → 分」逐级跳过不匹配的整段，而不是逐分钟走：
 * 此前永不匹配的表达式（`0 0 30 2 *`）要跑满 210 万次迭代（实测 ~70ms 同步阻塞）
 * 才能返回 null，daemon 启动的 catch-up 对每个此类任务都付一次。
 * 跳段仍用本地时间字段（setDate/setHours），保持本地墙钟语义——改成 UTC 毫秒算术会踩 DST。
 */
export function computeNextCronRun(cronExpr: string, fromMs: number): number | null {
  let parsed: ParsedCron;
  try {
    parsed = parseCron(cronExpr);
  } catch {
    return null;
  }

  const domRestricted = !isWildcard(cronExpr, 2);
  const dowRestricted = !isWildcard(cronExpr, 4);

  // 从下一分钟开始（对齐到分钟边界，秒清零）
  const cursor = new Date(fromMs);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const endMs = cursor.getTime() + SCAN_HORIZON_MS;

  while (cursor.getTime() <= endMs) {
    if (!parsed.months.has(cursor.getMonth() + 1)) {
      // 跳到下月 1 日 00:00
      moveCursor(cursor, 1, (d) => {
        d.setMonth(d.getMonth() + 1, 1);
        d.setHours(0, 0, 0, 0);
      });
      continue;
    }
    if (!dayMatches(parsed, cursor, domRestricted, dowRestricted)) {
      moveCursor(cursor, 1, (d) => {
        d.setDate(d.getDate() + 1);
        d.setHours(0, 0, 0, 0);
      });
      continue;
    }
    if (!parsed.hours.has(cursor.getHours())) {
      moveCursor(cursor, 1, (d) => d.setHours(d.getHours() + 1, 0, 0, 0));
      continue;
    }
    if (!parsed.minutes.has(cursor.getMinutes())) {
      moveCursor(cursor, 1, (d) => d.setMinutes(d.getMinutes() + 1));
      continue;
    }
    return cursor.getTime();
  }

  return null;
}

/**
 * 计算 (fromMs, untilMs] 区间内**最后一个**匹配时刻，无匹配返回 null。
 * 从 untilMs 往回扫（与 computeNextCronRun 对称地逐级跳段），O(1) 内存、无截断。
 * 区间下界与 computeNextCronRun 一致：只认 fromMs 所在分钟之后的分钟边界。
 */
export function computePrevCronRun(
  cronExpr: string,
  fromMs: number,
  untilMs: number,
): number | null {
  let parsed: ParsedCron;
  try {
    parsed = parseCron(cronExpr);
  } catch {
    return null;
  }
  if (untilMs <= fromMs) return null;

  const domRestricted = !isWildcard(cronExpr, 2);
  const dowRestricted = !isWildcard(cronExpr, 4);

  const floor = new Date(fromMs);
  floor.setSeconds(0, 0);
  const floorMs = floor.getTime();

  const cursor = new Date(untilMs);
  cursor.setSeconds(0, 0);

  while (cursor.getTime() > floorMs) {
    if (!parsed.months.has(cursor.getMonth() + 1)) {
      // 退到上月最后一分钟：本月 1 日 00:00 再减 1 分钟
      moveCursor(cursor, -1, (d) => {
        d.setDate(1);
        d.setHours(0, 0, 0, 0);
        d.setMinutes(-1);
      });
      continue;
    }
    if (!dayMatches(parsed, cursor, domRestricted, dowRestricted)) {
      moveCursor(cursor, -1, (d) => {
        d.setHours(0, 0, 0, 0);
        d.setMinutes(-1);
      });
      continue;
    }
    if (!parsed.hours.has(cursor.getHours())) {
      moveCursor(cursor, -1, (d) => {
        d.setMinutes(0, 0, 0);
        d.setMinutes(-1);
      });
      continue;
    }
    if (!parsed.minutes.has(cursor.getMinutes())) {
      moveCursor(cursor, -1, (d) => d.setMinutes(d.getMinutes() - 1));
      continue;
    }
    return cursor.getTime();
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
 * 上限 maxRuns 防止超长停机（如几年）枚举爆炸。
 * ⚠️ 截断是**从早往晚**截的：被截断时数组末尾是「第 maxRuns 次错过」而不是最后一次，
 * 要「最近一次」用 computeLatestMissedRun（反向扫描，不受截断影响）。
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
 *
 * 此前是「computeMissedRuns 枚举全部再取尾」：每分钟任务停机超过 6.9 天就撞上
 * maxRuns=10000 的前向截断，返回的是 20 天前的时刻，且 daemon 启动时同步枚举上万次。
 */
export function computeLatestMissedRun(
  cronExpr: string,
  fromMs: number,
  untilMs: number,
): number | null {
  return computePrevCronRun(cronExpr, fromMs, untilMs);
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
