/**
 * 等待准入判定：同一个对象同时只允许**一个有效的显式等待**。
 *
 * ## 要解决的事故（20261112 方案 R2）
 *
 * b0aa0f1e 在 46 秒内用同一个脚本起了 4 个 `run_in_background` + `wait_until_seconds` 后台等待，
 * 四个进程同时跑、先后以退出码 1 结束、**各送一条通知**；ca8d7e5c 与 8b8d721f 也是同型。
 * 根因不在某个工具：`registerWait` 的去重键是「工具调用 id」，而 bash 每次都生成新 id，
 * 永远不会撞；monitor 的同对象检查只在 monitor 之间比、且只追加一行提示照常启动；
 * 唤醒的单链替换只在唤醒之间生效。三个入口各自只管自己那一类，跨类完全没有协调。
 *
 * ## 一个判定函数，三个入口共用
 *
 * bash / monitor / schedule_wakeup 在**启动进程或排唤醒之前**都调这里。不在各工具里各写一份
 * 是因为判据有三个维度（对象签名、命令归一化、脚本正文哈希），任一处漏掉一个维度都会
 * 让「同一个对象只该有一个等待」在某条路径上失效，而那条路径不会有任何测试覆盖。
 *
 * ## 三个动作
 *
 * - `start`：没有同对象的等待，或本次等待抽不出对象签名（R2 修法 4：抽不出就放行——
 *   把两个无关的后台任务判成重复，比多起一个进程更糟）；
 * - `duplicate`：同一件事的重复（同对象 + 命令归一化相同且脚本正文未变 / 新期限落在
 *   已有等待剩余期限之内）。**不启动**，直接返回回执，`isError: false`；
 * - `replace`：同对象但换了一种等法（脚本改了、从唤醒换成后台循环）。R2 只判定不执行淘汰，
 *   启动新的、旧的照旧跑——淘汰见 R6。这里返回 `replace` 而不是塞进 `start`，是为了让
 *   R6 能只改调用点、不再动判据。
 *
 * ## 回执必须给出口
 *
 * duplicate 会**拒绝**模型明确想要的第二个等待（§五「牺牲了什么」）。唯一的缓解是回执里
 * 写清「旧的还在跑、它结束时会有通知、真要换等法先 `task_stop <id>`」——不给出口，
 * 模型改了脚本也挂不上新的，只能去前台轮询，那就把 R2 的收益又赔回去了。
 */

import type { WaitSource } from "./wait-registry.ts";
import { isDeclaredExternalWait, listWaits, releaseWait } from "./wait-registry.ts";
import { updateTask } from "./registry.ts";
import { killShellTask } from "./shell-task.ts";
import { killMonitorTask } from "./monitor-task.ts";
import { getScheduler } from "../cron/scheduler.ts";
import { formatClockWithSeconds } from "./monitor-text.ts";
import { normalizeWaitCommand } from "./wait-subjects.ts";

/** 准入结论（闭集）：新增分支必须同时改三入口的 switch */
export type WaitAdmissionAction = "start" | "duplicate" | "replace";

export interface WaitAdmissionInput {
  /** 即将登记的任务 id（可能尚未生成；生成后用于排除自身的旧登记） */
  id?: string;
  /** 等待对象的签名，来自 `extractWaitSubjectsFor` */
  subjects?: string[];
  /** 归一化前的原始命令 / 唤醒 prompt */
  command?: string;
  /** 脚本正文哈希（`extractWaitSubjectsFor` 的产物） */
  scriptHash?: string;
  /** 新等待的绝对期限（deadline 类才有） */
  deadlineAt?: number;
}

export interface WaitAdmissionDecision {
  action: WaitAdmissionAction;
  /** 同对象的**有效显式等待**（已终态 / 已释放的不在其中）。回执与 R6 的淘汰都用它 */
  existing: WaitSource[];
}

/**
 * 找出盯着这些对象的有效显式等待。
 *
 * 复用 `listWaits` + `isDeclaredExternalWait` 而不另立事实源：`listWaits` 已经在做
 * 「终态即失效 + 期限违约兜底 + 派生分支补齐」，另写一份查询必然在两处判据上分叉
 * （R2 验收 1 里「已有等待已终态 → start」这条就是靠它成立的）。
 */
export function findActiveWaitsBySubjects(subjects: string[], now = Date.now()): WaitSource[] {
  if (subjects.length === 0) return [];
  const wanted = new Set(subjects);
  return listWaits(now).filter(
    (src) => isDeclaredExternalWait(src) && (src.subjects ?? []).some((s) => wanted.has(s)),
  );
}

/**
 * 判定本次等待该怎么处理。纯函数（除了读等待表），三入口共用。
 *
 * `id` 用于排除自身：同一个任务重复登记（例如 monitor 的 adopt 路径会二次登记）不该
 * 把自己当成「已有的同对象等待」而判成 duplicate。
 */
export function decideWaitAdmission(
  input: WaitAdmissionInput,
  now = Date.now(),
): WaitAdmissionDecision {
  const subjects = input.subjects ?? [];
  // R2 修法 4：抽不出对象签名 → 不参与去重，行为与改动前一致
  if (subjects.length === 0) return { action: "start", existing: [] };

  const existing = findActiveWaitsBySubjects(subjects, now).filter(
    (src) => input.id === undefined || src.id !== input.id,
  );
  if (existing.length === 0) return { action: "start", existing: [] };

  const incoming = input.command ? normalizeWaitCommand(input.command) : undefined;
  // 脚本正文没变才可能是同一个脚本的另一份拷贝；一边有一边没有（比如命令行直接跑循环）
  // 视为「没有可比性」，这一维不作判据——否则第一次挂脚本、第二次挂等价命令行会被误判重复。
  const comparableScript =
    input.scriptHash === undefined
      ? undefined
      : (src: WaitSource) =>
          src.scriptHash === undefined ? false : src.scriptHash === input.scriptHash;

  for (const src of existing) {
    // 判据 1：同对象 + 归一化命令相同 + 脚本正文未变 → 同一件事的重复
    if (incoming !== undefined && src.command !== undefined) {
      if (normalizeWaitCommand(src.command) === incoming) {
        const scriptSame = comparableScript ? comparableScript(src) : true;
        if (scriptSame) return { action: "duplicate", existing };
      }
    }
    // 判据 2：新期限落在已有等待的剩余期限之内 → 就算换了个说法，也收不到已有等待
    // 收不到的信息之外的任何东西（b0aa0f1e 的第 2 次：命令一样，期限从 1800 缩到 1500）
    if (
      input.deadlineAt !== undefined &&
      src.promise.kind === "deadline" &&
      input.deadlineAt <= src.promise.deadlineAt
    ) {
      return { action: "duplicate", existing };
    }
  }
  return { action: "replace", existing };
}

/**
 * duplicate 的回执正文（文档 §R2 修法 2 的模板，三入口共用一份）。
 *
 * 三件事缺一不可：① 说明**没有**启动第二个；② 说出在盯哪些对象、旧的几点最晚回报
 * （模型据此判断「不用再挂」）；③ 给出口（否则换等法无路可走：改了脚本也挂不上新的，
 * 只能回前台轮询，R2 的收益又赔回去）。
 *
 * 出口命令**按 kind 区分**：唤醒不在 task registry 里，`task_stop` 停不掉它。
 * 给错命令比不给更糟——模型会执行一条必然失败的命令，然后自己去前台查。
 */
export function formatDuplicateWaitReceipt(existing: WaitSource[], subjects: string[]): string {
  // 只列第一条的「最晚回报」：多个同对象等待是**历史遗留**（R2 上线前起的那批），
  // 逐个列出会变成一串噪音，而模型只需要知道「最早那条什么时候回来」。
  const first = existing[0]!;
  const deadlineText =
    first.promise.kind === "deadline"
      ? `，最晚 ${formatClockWithSeconds(first.promise.deadlineAt)} 回报`
      : "，结束时会有通知";
  const subjectText = subjects.length > 0 ? `，对象 ${subjects.join(" / ")}` : "";
  const lines = [
    "已有等待在盯同一个对象，本次未重复启动：",
    `- ${kindLabel(first.kind)} ${first.id}（${first.description}）${subjectText}${deadlineText}`,
    "它结束或到期时会以通知送达，期间不需要再挂等待，也不需要手动查询。",
    `如果你确实要换一种等法（比如改了脚本），先 ${stopCommand(first)} 停掉它，再重新启动。`,
  ];
  // 历史遗留的并行等待也点出来：不回显的话模型会以为只有一条，收不到其余几条的通知时
  // 又会去前台查（R3 的形态）。
  if (existing.length > 1) {
    const others = existing.slice(1).map((src) => src.id);
    lines.push(`（另有 ${others.length} 个同对象等待也在跑：${others.join("、")}）`);
  }
  return lines.join("\n");
}

/** 停掉这个等待源的命令（回执里给模型直接用，见上面「给错命令比不给更糟」） */
export function stopCommand(src: WaitSource): string {
  return src.kind === "wakeup" ? `cron_delete ${src.id}` : `task_stop ${src.id}`;
}

/**
 * R6：淘汰被替换的旧等待（`decideWaitAdmission` 返回 `replace` 时由入口调用）。
 *
 * ## 调用时序是契约，不是偏好
 *
 * 入口必须**先启动并登记新的等待，再调这里**。反过来会有一个「没有任何等待源」的空窗，
 * 被 todo 闸门判成「没人会回来」而强推模型继续干活——那正是 R6 要消除的形态
 * （ca8d7e5c 里模型在等 CI，闸门却催它推进别的待办）。
 *
 * ## 为什么只淘汰这三类
 *
 * `isDeclaredExternalWait` 的定义域是 shell-deadline / monitor / wakeup：它们都是**模型声明的
 * 等待方式**，换一种等法意味着旧的那种不再有信息量。agent / workflow 是模型要等的**产出**，
 * 换等法不该顺手杀掉一个正在干活的子代理，所以即便将来它们进入 `existing` 也保持不动。
 *
 * ## 唤醒是兜底，不淘汰任何主动等待
 *
 * `newKind === "wakeup"` 时本函数直接返回空。唤醒的语义是「过一会儿回来看看」，它天然与
 * 正在跑的 monitor / 后台等待**互补**——S2 的设计就是「monitor 盯对象 + 唤醒兜底」，
 * monitor 成功终态后撤销唤醒（`invalidateWakeupsForDeliveredTask`）。把新起唤醒当成
 * 「换了一种等法」去 kill 掉 monitor，会拆掉这条链：monitor 被 kill 后通知不入队，
 * 兜底唤醒反而永远撤不掉（`wakeup-invalidation-chain` 的真实入口用例实测红）。
 * 反方向不受影响：新起 shell / monitor 仍淘汰旧的唤醒（方案 §R6 验收 2）。
 *
 * ## 顺序：先标记、再释放、最后 kill
 *
 * - `supersededBy` 必须在 kill **之前**写进任务状态：`killShellTask` 在同一个函数里完成
 *   终态写入与通知入队，晚一步通知就已经进队列了（`enqueueTaskNotification` 靠这个字段跳过）；
 * - `WaitReleased(superseded)` 也必须在 kill 之前：终态释放路径会把它记成 `terminal`，
 *   两者在轨迹上必须能分开（方案 §R6 修法 2）。
 *
 * 返回实际被淘汰的源，供回执列出（`agent`/`workflow` 不淘汰，不能出现在回执里）。
 */
export function supersedeReplacedWaits(
  existing: WaitSource[],
  newId: string,
  newKind: WaitSource["kind"],
): WaitSource[] {
  if (newKind === "wakeup") return [];
  const stopped: WaitSource[] = [];
  for (const src of existing) {
    if (src.id === newId) continue;
    switch (src.kind) {
      case "shell": {
        markTaskSuperseded(src.id, newId);
        releaseWait(src.id, "superseded");
        killShellTask(src.id, { summary: `已被 ${newId} 替换（同一对象换了等法，无需再等）` });
        stopped.push(src);
        break;
      }
      case "monitor": {
        markTaskSuperseded(src.id, newId);
        releaseWait(src.id, "superseded");
        killMonitorTask(src.id);
        stopped.push(src);
        break;
      }
      case "wakeup": {
        // 与 `cron_delete` 同一条路径：先从调度器摘掉，再按 superseded 释放
        getScheduler().removeTask(src.id);
        releaseWait(src.id, "superseded");
        stopped.push(src);
        break;
      }
      case "agent":
      case "workflow":
        break;
    }
  }
  return stopped;
}

/** 替换回执（与 schedule_wakeup 现有 `replacedNote` 同一句式） */
export function formatReplaceNote(stopped: WaitSource[], newId: string): string {
  if (stopped.length === 0) return "";
  const items = stopped.map((src) => `${src.id}（${src.description}）`).join("、");
  return `\n已替换此前在盯同一对象的等待：${items}（新等待 ${newId} 接管，旧的不再送终态通知）。`;
}

/**
 * 把任务标记为「被新任务替换」。
 *
 * 单独一个函数而不是内联在 kill 里：标记必须在 kill 与通知入队之前落地，且两条 kill 路径
 * （shell / monitor）共用同一口径。已标记过就保留第一次的值——并存替换时先被替换的那个
 * 才是「旧」，后来的任务不该把溯源指针改写成自己。
 */
function markTaskSuperseded(taskId: string, newId: string): void {
  updateTask(taskId, (t) => (t.supersededBy ? t : { ...t, supersededBy: newId }));
}

function kindLabel(kind: WaitSource["kind"]): string {
  switch (kind) {
    case "shell":
      return "后台命令";
    case "monitor":
      return "监控任务";
    case "wakeup":
      return "定时唤醒";
    case "agent":
      return "子代理";
    case "workflow":
      return "workflow";
  }
}
