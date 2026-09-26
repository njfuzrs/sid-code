import type { LocalCommandModule } from "../../types.ts";
import { randomBytes } from "crypto";

/**
 * /loop 命令实现（缺口 A，按需加载）
 *
 * 四种用法（对标 cc /loop）：
 * 1. 前导间隔：/loop 5m <prompt>            → 间隔转 cron → 直接创建循环任务
 * 2. 尾随间隔：/loop <prompt> every 2 hours → 同上（CC 的自然语言写法，间隔在句尾）
 * 3. 动态间隔：/loop <prompt>               → submit_prompt 引导模型用 schedule_wakeup 自适应轮询
 * 4. 空跑：    /loop                         → 列出当前定时任务
 *
 * 固定间隔走本地直建（复用 Scheduler），不绕模型，即时确认；动态间隔交给模型决策。
 * 前导与尾随两种写法解析出间隔后走**同一段**建任务逻辑——两份就会漂移。
 */

function shortId(): string {
  return randomBytes(4).toString("hex");
}

/** 第一个 token 看起来像间隔（5m / 30s / 1h30m / 纯数字）则返回它，否则 null */
function extractLeadingInterval(args: string): { interval: string; rest: string } | null {
  const trimmed = args.trim();
  const spaceIdx = trimmed.search(/\s/);
  const first = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  // 间隔形态：纯数字 或 仅由 数字+hms 单位组成
  if (/^\d+$/.test(first) || /^(\d+\s*(h|m|s))+$/i.test(first)) {
    return { interval: first, rest };
  }
  return null;
}

/**
 * 尾随 `every` 子句（CC 写法）：`review PRs every 2 hours` / `check build every 5 minutes`。
 *
 * 只认句尾，且 `every` 必须是独立词——任务正文里出现 every（如 "review every PR"）
 * 不该被当成间隔。单位收成 interval.ts 能解析的 h/m/s：
 * hour(s)/hr → h，minute(s)/min → m，second(s)/sec → s。
 * 解析不出（没有 every、every 不在句尾、单位不认识）返回 null，调用方落动态轮询。
 */
function extractTrailingEvery(args: string): { interval: string; rest: string } | null {
  const UNIT_TO_SHORT: Record<string, string> = {
    hour: "h",
    hours: "h",
    hr: "h",
    hrs: "h",
    minute: "m",
    minutes: "m",
    min: "m",
    mins: "m",
    second: "s",
    seconds: "s",
    sec: "s",
    secs: "s",
  };
  const m = args.trim().match(/\severy\s+(\d+)\s+(hours?|hrs?|minutes?|mins?|seconds?|secs?)\s*$/i);
  if (!m) return null;
  const unit = UNIT_TO_SHORT[m[2].toLowerCase()];
  if (!unit) return null;
  const rest = args.trim().slice(0, m.index).trim();
  if (!rest) return null;
  return { interval: `${m[1]}${unit}`, rest };
}

const mod: LocalCommandModule = {
  async call(args, _ctx) {
    const trimmed = args.trim();

    const { getScheduler } = await import("@sid-code/core/cron/scheduler.ts");
    const { isCronDisabled, MAX_SESSION_CRON_JOBS } = await import("@sid-code/core/cron/types.ts");
    // 禁用时三态（列出/固定间隔/动态轮询）全部拒绝：动态轮询最终也落成 schedule_wakeup，
    // 只拦前两种会让模型绕开开关继续建任务。
    if (isCronDisabled()) {
      return {
        type: "text",
        value: "cron 已被 SID_CODE_DISABLE_CRON 禁用，/loop 不可用。",
      };
    }
    const scheduler = getScheduler();

    // 用法 4：空跑 → 列出当前定时任务
    if (!trimmed) {
      const tasks = scheduler.listTasks();
      if (tasks.length === 0) {
        return {
          type: "text",
          value:
            "当前没有定时任务。\n用法：\n" +
            "  /loop 5m <任务>              按固定间隔重复（如每 5 分钟检查部署）\n" +
            "  /loop <任务> every 2 hours   同上，间隔写在句尾\n" +
            "  /loop <任务>                 自适应轮询（模型自选下次检查时机，适合「跑到 CI 过为止」）",
        };
      }
      const lines = tasks.map((t) => {
        const kind = t.recurring ? "循环" : "一次性";
        const durable = t.durable ? " [持久]" : "";
        return `  ${t.id}  ${t.cron || "(动态)"}  ${kind}${durable}  ${t.prompt.slice(0, 50)}`;
      });
      return {
        type: "text",
        value: `当前定时任务（${tasks.length}）：\n${lines.join("\n")}\n\n用 /loop 5m <任务> 新建，或让我用定时工具删除。`,
      };
    }

    // 用法 1/2：固定间隔 → 转 cron 直接建任务。
    // 前导优先（/loop 5m task），没有再试尾随 every（/loop task every 2 hours）。
    const fixed = extractLeadingInterval(trimmed) ?? extractTrailingEvery(trimmed);
    if (fixed && fixed.rest) {
      const { intervalToCron } = await import("@sid-code/core/cron/interval.ts");
      const result = intervalToCron(fixed.interval);
      if (!result) {
        return {
          type: "text",
          value:
            `间隔 "${fixed.interval}" 无法用 cron 周期精确表达（cron 要求间隔能整除小时/天，如 5m/15m/30m/1h/2h）。\n` +
            `改用自适应轮询：直接 /loop ${fixed.rest}（不带间隔），由我自选检查节奏。`,
        };
      }

      const task = {
        id: shortId(),
        cron: result.cron,
        prompt: fixed.rest,
        createdAt: Date.now(),
        recurring: true,
        durable: false,
      };
      if (!scheduler.addSessionTask(task)) {
        return {
          type: "text",
          value: `已达定时任务上限 (${MAX_SESSION_CRON_JOBS})，请先删除不需要的任务后再建。用 /loop（无参数）查看现有任务。`,
        };
      }

      const mins = Math.round(result.totalSeconds / 60);
      const everyLabel = mins >= 60 ? `${Math.round(mins / 60)} 小时` : `${mins} 分钟`;
      return {
        type: "text",
        value:
          `已创建循环任务（每${everyLabel}，会话级，7 天后过期），ID: ${task.id}\n` +
          `cron: ${result.cron}\n任务: ${fixed.rest}\n\n` +
          `空闲时会自动触发；忙时排队。用 /loop 查看，或让我删除任务 ${task.id}。`,
      };
    }

    // 用法 3：无间隔 → 动态自适应轮询，引导模型用 schedule_wakeup
    return {
      type: "submit_prompt",
      prompt:
        `<loop-task>\n${trimmed}\n</loop-task>\n\n` +
        `用户要求以「自适应轮询」方式重复上面的任务，直到达成目标。请按如下方式工作：\n` +
        `1. 现在立即执行一次该任务，检查当前状态。\n` +
        `2. 若目标尚未达成，调用 schedule_wakeup 工具安排下次检查：delaySeconds 自己定` +
        `（钳制在 60~3600 秒之间），并在 reason 里说明为何选这个延迟。\n` +
        `3. 每次被唤醒后重复「检查 → 未达成则再 schedule_wakeup」，直到目标达成后停止（不再安排唤醒）。\n` +
        `延迟取舍：prompt 缓存约 5 分钟过期，优先选 <270s 或 ≥1200s，避开 300s 附近。`,
    };
  },
};

export default mod;
