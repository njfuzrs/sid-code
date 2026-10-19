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
  if (
    /^\d+$/.test(min) &&
    everyField(hour) &&
    everyField(dom) &&
    everyField(mon) &&
    everyField(dow)
  ) {
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

/**
 * 一次性绝对唤醒（schedule_wakeup 的 fireAt 任务，cron 为空串）的展示。
 * 这类任务没有 cron 可描述，此前走 cronToHuman("") 渲染成空白——
 * 用户排查「轮询怎么没醒」时列表里只有一条没有时间的条目。
 */
export function fireAtToHuman(fireAt: number, now: number = Date.now()): string {
  const d = new Date(fireAt);
  const at = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const diffSec = Math.round((fireAt - now) / 1000);
  if (diffSec <= 0) return `${at} 唤醒（已到期，等会话空闲）`;
  const rel =
    diffSec < 60
      ? `${diffSec} 秒后`
      : diffSec < 3600
        ? `${Math.round(diffSec / 60)} 分钟后`
        : `${(diffSec / 3600).toFixed(1)} 小时后`;
  return `${at} 唤醒（${rel}）`;
}

/** 任务调度列的统一展示：fireAt 任务显示触发时刻，cron 任务显示人类可读描述 + 原式 */
export function describeTaskSchedule(
  task: { cron: string; fireAt?: number },
  now?: number,
): string {
  if (task.fireAt !== undefined) return fireAtToHuman(task.fireAt, now);
  const human = cronToHuman(task.cron);
  // 回落时 human 已是 "cron: ..."，避免重复展示
  return human.startsWith("cron:") ? task.cron : `${human}（${task.cron}）`;
}
