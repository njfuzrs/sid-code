/**
 * Cron 表达式 → 人类可读描述（对齐 claude-code CronListTool 的 humanSchedule）。
 *
 * 覆盖最常见的调度模式，做启发式识别；不常见的组合回落到「原始 cron 表达式」原样展示。
 * 目标是让 cron_list 输出更易读，而非完整自然语言引擎——识别不了就老实回落，绝不误导。
 */

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 把 0-6（0=周日，也接受 7=周日）转中文星期。 */
function weekdayName(n: number): string {
  return WEEKDAYS[n % 7] ?? String(n);
}

/** 两位补零。 */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 生成人类可读描述。识别失败时返回 `每 cron: <expr>`（原样回落，不猜）。
 */
export function cronToHuman(cronExpr: string): string {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return `cron: ${cronExpr}`;
  const [min, hour, dom, mon, dow] = fields;

  const everyField = (f: string) => f === "*";

  // 每 N 分钟：*/N * * * *
  const minStep = /^\*\/(\d+)$/.exec(min);
  if (minStep && everyField(hour) && everyField(dom) && everyField(mon) && everyField(dow)) {
    return `每 ${minStep[1]} 分钟`;
  }

  // 每小时（第 M 分钟）：M * * * *
  if (/^\d+$/.test(min) && everyField(hour) && everyField(dom) && everyField(mon) && everyField(dow)) {
    return Number(min) === 0 ? "每小时整点" : `每小时第 ${Number(min)} 分钟`;
  }

  // 每 N 小时：M */N * * *
  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (/^\d+$/.test(min) && hourStep && everyField(dom) && everyField(mon) && everyField(dow)) {
    return `每 ${hourStep[1]} 小时（第 ${Number(min)} 分钟）`;
  }

  // 固定时刻 H:M，按 dom/dow 细分
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const time = `${pad2(Number(hour))}:${pad2(Number(min))}`;

    // 每天 H:M
    if (everyField(dom) && everyField(mon) && everyField(dow)) {
      return `每天 ${time}`;
    }

    // 每周某几天 H:M：dow 为单值/列表/范围
    if (everyField(dom) && everyField(mon) && !everyField(dow)) {
      // 工作日 1-5
      if (dow === "1-5") return `工作日 ${time}`;
      // 列表/单值
      if (/^[0-7](,[0-7])*$/.test(dow)) {
        const days = dow.split(",").map((d) => weekdayName(Number(d)));
        return `每${days.join("、")} ${time}`;
      }
      // 范围 a-b
      const range = /^(\d)-(\d)$/.exec(dow);
      if (range) {
        return `${weekdayName(Number(range[1]))}至${weekdayName(Number(range[2]))} ${time}`;
      }
    }

    // 每月某日 H:M
    if (/^\d+$/.test(dom) && everyField(mon) && everyField(dow)) {
      return `每月 ${Number(dom)} 日 ${time}`;
    }
  }

  // 识别不了：原样回落
  return `cron: ${cronExpr}`;
}
