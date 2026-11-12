/**
 * MonitorTool（M1：按行事件监控外部状态）
 *
 * 对标 claude-code 的 `Monitor`。与 `bash run_in_background` 的分工：
 * - **只要一次通知**（「CI 全绿告诉我」）→ bash 后台 + `wait_until_seconds`，命令写成
 *   条件满足就退出的循环；
 * - **每次发生都要通知**（「每个检查完成告诉我」「日志里每出现 ERROR 告诉我」）→ 本工具。
 *
 * stdout 每一行（经 200ms 批处理）是一条通知；进程退出或期限到即结束，终态必回报。
 * 模型挂上之后应当 `end_turn`——等待期前台零请求，这正是事故会话 7dd98bf5 / 9e3a681d
 * 反复前台轮询 96 / 106 次 `gh pr checks` 要收口的行为。
 *
 * ## 权限
 *
 * `command` 走 bash **同一条**权限管线（见 `permission/checker.ts` 的 monitor → bash
 * 等效请求）：`Bash(gh pr checks:*)` 这类规则对 monitor 同样生效，deny 规则同样拦。
 * 本工具的 `checkPermissions` 只补工具自身的判定，二者叠加而非替代。
 *
 * ## 为什么 resultDisplayMode = "summary"
 *
 * 工具结果正文（下面 `execute` 返回的那段）是**给模型的收尾指令**，不是给用户看的。
 * 原样展示会把「不需要查询状态，也不需要 sleep」这类提示词漏到屏幕上（`todo_write`
 * 泄漏 1053 字符提示词的同类问题）。TUI 只显示 header 摘要一行。
 */

import type { PermissionResult, Tool, ToolResult, ToolUseContext } from "./types.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";
import { getCwd } from "../bootstrap/state.ts";
import { getLogger } from "../debug/logger.ts";
import {
  MAX_MONITOR_TIMEOUT_MS,
  MIN_MONITOR_TIMEOUT_MS,
  DEFAULT_MONITOR_TIMEOUT_MS,
  getMaxConcurrentMonitors,
  getMaxMonitorTimeoutMs,
  getDefaultMonitorTimeoutMs,
  countRunningMonitors,
  spawnMonitorTask,
  isMonitorTask,
} from "../task/index.ts";
import { getMonitorPolicySettings } from "../config/monitor-policy.ts";
import { getRunningTasks } from "../task/registry.ts";
import { registerWait, isWakeupRegistrationEnabled } from "../task/wait-registry.ts";
import {
  collectWaitCommandFamilies,
  collectWaitSubjects,
  normalizeWaitCommand,
} from "../task/wait-subjects.ts";
import {
  decideWaitAdmission,
  formatDuplicateWaitReceipt,
  formatReplaceNote,
  supersedeReplacedWaits,
} from "../task/wait-admission.ts";
import { formatClockWithSeconds } from "../task/monitor-text.ts";
import { isReadOnlyCommand, isDestructiveCommand } from "./bash/read-only-validation.ts";

const monitorSchema = lazySchema(() =>
  z.object({
    description: z
      .string()
      .min(1)
      .max(80)
      .describe("监控对象的短描述，出现在每条通知里（如「PR #662 CI」而不是「watching」）"),
    command: z
      .string()
      .min(1)
      .describe(
        "shell 脚本：stdout 每行一个事件，进程退出即监控结束。只打你要据此行动的行；管道每段都要逐行刷新（grep --line-buffered / awk fflush），不要用 head。",
      ),
    timeout_ms: z
      .number()
      .describe(
        `硬期限（毫秒），默认 ${DEFAULT_MONITOR_TIMEOUT_MS}，下限 ${MIN_MONITOR_TIMEOUT_MS}、上限 ${MAX_MONITOR_TIMEOUT_MS}（超过即钳制；企业策略可用 settings.monitor.maxTimeoutMs 收紧上限）。到期必回报并结束。`,
      )
      .optional(),
  }),
);

type MonitorInput = {
  description?: unknown;
  command?: unknown;
  timeout_ms?: unknown;
};

/** 当前运行中的 monitor 简要清单（并发上限错误里列给模型，它才知道该 task_stop 谁） */
function listRunningMonitorBrief(): string {
  return getRunningTasks()
    .filter(isMonitorTask)
    .map((t) => `${t.id}（${t.description}）`)
    .join("、");
}

export class MonitorTool implements Tool<MonitorInput, string> {
  readonly zodSchema = monitorSchema();
  /**
   * 延迟加载：与 `schedule_wakeup` 同档（长尾、低频）。关键词覆盖中英文常见说法，
   * 让 `tool_search` 在「等 CI」「watch」「监控」这类描述下都能把它调出来。
   */
  readonly shouldDefer = true;
  readonly searchHint = "monitor watch wait ci poll stream events 监控 等待 轮询 事件";
  /**
   * D6：何时该用（一句话）。刻意不写选择边界细节（与 bash 后台的分工、轮询间隔、
   * 沉默不等于成功）——那些在 <waiting-capability> 专属段（FIX-3），两段按「专属段讲深度、
   * 速查段讲广度」分工，tests/tool/deferred-guidance.test.ts 有断言机械拦住重复。
   */
  readonly guidance = "要盯外部状态的行级事件流（stdout 每行一条通知）时用。";
  /**
   * 结果正文是给模型的收尾指令（见文件头注释），TUI 只留 header 摘要。
   * 错误路径照常展示（`resultDisplayMode` 的硬约束：hidden/summary 不吞错误）。
   */
  readonly resultDisplayMode = "summary" as const;

  /** 新版 Tool 接口：name 是字符串属性（旧接口才是 name() 方法）。 */
  readonly name = "monitor";

  description(): string {
    return `按行事件监控外部状态：后台脚本的 stdout 每行 → 一条通知，进程退出或期限到必有终态回报。

**先选对工具**：
- 只要一次通知（「CI 全绿 / 构建完了告诉我」）→ bash + run_in_background=true + wait_until_seconds，命令写成条件满足就退出的循环；
- 每次发生都要通知（「每个检查完成告诉我」「日志里每出现 ERROR 告诉我」）→ 本工具。

**stdout 就是事件流**：只打你要据此行动的行；管道每一段都要逐行刷新（grep --line-buffered、awk 里 fflush()；head 不能用）。

**脚本结束即监控结束**：父进程退出后，仍占着 stdout 的孙进程（如 \`tail -f x &\`）会被一并清理。不要靠 \`&\` 留后台监听——需要长期监控就把循环写成前台脚本（如下面的示例），或换一个专门的工具/服务跑。

**沉默不等于成功**：过滤条件必须覆盖所有终态，失败 / 取消 / 超时都要打出来。0 条事件到期时系统会提示你检查过滤条件。

**轮询间隔**：远端 API ≥ 30 秒，本地检查 0.5–1 秒；单次请求失败不要让脚本退出（|| true）。

**挂上之后**：不要再手动查询同一个状态；没有别的事就告诉用户在等什么，然后结束本轮。事件已经展示给用户，收到事件时不需要复述，没有需要做的事就直接结束本轮。

**企业管控**：\`settings.monitor\` 可关闭本工具或收紧并发 / 期限上限（只收紧、不放宽），只对本轮之后新启动的监控生效，已在运行的监控不受影响。

示例（PR CI 逐项结束才打一行，全部结束后打 ALL_DONE 并退出）：
\`\`\`bash
pr=662; interval=45; prev=""
while true; do
  s=$(gh pr checks "$pr" --json name,bucket 2>/dev/null) || { sleep "$interval"; continue; }
  cur=$(jq -r '.[] | select(.bucket!="pending") | "\\(.name): \\(.bucket)"' <<<"$s" | sort)
  comm -13 <(printf '%s\\n' "$prev") <(printf '%s\\n' "$cur")
  prev="$cur"
  if jq -e 'length>0 and all(.bucket!="pending")' <<<"$s" >/dev/null; then
    if jq -e 'all(.bucket=="pass" or .bucket=="skipping")' <<<"$s" >/dev/null; then echo "ALL_DONE: pass"; exit 0; fi
    echo "ALL_DONE: fail"; exit 1
  fi
  sleep "$interval"
done
\`\`\`

示例（等本地服务就绪，成功后退出的 until 写法）：
\`\`\`bash
until curl -sf localhost:3000/health >/dev/null; do sleep 1; done; echo "service ready"
\`\`\``;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(monitorSchema()) as Record<string, unknown>;
  }

  /**
   * 工具级权限：与 bash 的 `checkPermissions` **同一套判定**（只读放行 / 破坏性要求
   * 确认 / 其余 passthrough）。命令规则的完整匹配在 checker 里经 monitor → bash
   * 等效请求完成，这里只补工具自身这一层。
   */
  async checkPermissions(input: MonitorInput, _context: ToolUseContext): Promise<PermissionResult> {
    const command = (input as { command?: unknown })?.command;
    if (typeof command !== "string" || command.length === 0) return { behavior: "passthrough" };
    if (isReadOnlyCommand(command)) return { behavior: "allow" };
    if (isDestructiveCommand(command)) {
      return {
        behavior: "ask",
        message: `监控脚本含破坏性命令，需要确认: ${command.slice(0, 80)}`,
      };
    }
    return { behavior: "passthrough" };
  }

  /** 只读语义上不可判定（脚本可能做任何事）；并发安全为 false，不与其它工具并行 */
  isReadOnly(): boolean {
    return false;
  }

  isConcurrencySafe(): boolean {
    return false;
  }

  isEnabled(): boolean {
    return getMonitorPolicySettings().enabled;
  }

  async call(input: MonitorInput): Promise<ToolResult<string>> {
    const params = input ?? {};

    // 企业策略关闭（settings.monitor.enabled=false）：正常路径是 isEnabled() 把工具挡出
    // schema 与 tool_search，但模型凭历史上下文按名直调仍会到执行层（与 bundled skill 的
    // isEnabled 同形态：挡 schema 不等于执行层不可达），所以这里再拦一次并说明原因。
    if (!getMonitorPolicySettings().enabled) {
      return {
        data: "错误: monitor 已被企业策略禁用（settings.monitor.enabled=false）。请改用 bash + run_in_background + wait_until_seconds 等待。",
        isError: true,
      };
    }

    const description = typeof params.description === "string" ? params.description.trim() : "";
    const command = typeof params.command === "string" ? params.command : "";

    if (!description) {
      return {
        data: "错误: 缺少必需参数 description（监控对象的短描述，如「PR #662 CI」）",
        isError: true,
      };
    }
    if (description.length > 80) {
      return {
        data: `错误: description 超过 80 字符（当前 ${description.length}）`,
        isError: true,
      };
    }
    if (!command.trim()) {
      return {
        data: "错误: 缺少必需参数 command（stdout 每行一个事件的 shell 脚本）",
        isError: true,
      };
    }

    // timeout_ms：不传用默认（受企业上限约束）；0 / 负数 / 非有限数拒绝（T-M1-2）。
    // 上限取 `min(代码常量, settings.monitor.maxTimeoutMs)`：配置只能收紧，
    // 写 300000 而企业上限 60000 时钳到 60s 并在结果里注明（FIX-7 验收）。
    const effectiveMaxTimeoutMs = getMaxMonitorTimeoutMs();
    const effectiveDefaultTimeoutMs = getDefaultMonitorTimeoutMs();
    let timeoutMs = effectiveDefaultTimeoutMs;
    if (params.timeout_ms !== undefined) {
      const raw = params.timeout_ms;
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return { data: "错误: timeout_ms 必须是有限数字（毫秒）", isError: true };
      }
      if (raw <= 0) {
        return {
          data: `错误: timeout_ms 必须大于 0（收到 ${raw}）。省略该参数时默认 ${effectiveDefaultTimeoutMs}ms。`,
          isError: true,
        };
      }
      timeoutMs = raw;
    }
    let clampNote = "";
    if (timeoutMs < MIN_MONITOR_TIMEOUT_MS) {
      clampNote = `（已从 ${Math.round(timeoutMs)}ms 钳制到下限 ${MIN_MONITOR_TIMEOUT_MS}ms）`;
      timeoutMs = MIN_MONITOR_TIMEOUT_MS;
    } else if (timeoutMs > effectiveMaxTimeoutMs) {
      clampNote = `（已从 ${Math.round(timeoutMs)}ms 钳制到上限 ${effectiveMaxTimeoutMs}ms）`;
      timeoutMs = effectiveMaxTimeoutMs;
    }

    // 并发上限：每个 monitor 都是一个常驻进程 + 一个潜在的通知源，默认 4 个已覆盖
    // 「CI + 部署 + 日志 + 一个备用」。第 N+1 个直接拒绝并列出是谁在占位。
    // N = `min(代码常量, settings.monitor.maxConcurrent)`，只收紧不放宽。
    const effectiveMaxConcurrent = getMaxConcurrentMonitors();
    if (countRunningMonitors() >= effectiveMaxConcurrent) {
      return {
        data: `错误: 同时运行的 monitor 已达上限 ${effectiveMaxConcurrent} 个（当前：${listRunningMonitorBrief()}）。请先用 task_stop 停掉不需要的监控。`,
        isError: true,
      };
    }

    // R2：同一个对象同时只允许一个**有效的显式等待**，且跨类（shell × monitor × wakeup）。
    // 原来这里只在 monitor 之间比、且只追加一行提示就照常启动——b0aa0f1e 的四份同脚本进程
    // 正是「每个入口只管自己那一类」的产物。现在走统一判定：重复则不 spawn，直接返回回执。
    const subjects = collectWaitSubjects({ command });
    const normalizedCommand = normalizeWaitCommand(command);
    const admission = decideWaitAdmission({
      subjects,
      command: normalizedCommand,
      deadlineAt: Date.now() + timeoutMs,
    });
    if (admission.action === "duplicate") {
      return {
        data: formatDuplicateWaitReceipt(admission.existing, subjects),
        isError: false,
      };
    }
    // replace（R6）：模型换了一种等法（改了脚本 / 从唤醒或后台循环换成监控）。
    // 淘汰放在 spawn + 登记**之后**（见下方），先停旧再起新会留下一个没有任何等待源的空窗。

    const taskState = spawnMonitorTask({
      description,
      command,
      timeoutMs,
      cwd: getCwd(),
    });

    // 登记为等待源（deadline 承诺）：todo 闸门 T2 据此放行、静默判据不误杀。
    // `commandFamilies` 是 D13 的字段级覆盖依据：P1 只有在「monitor 脚本里也出现
    // 同一命令族」时才认为这条查询被覆盖、可以拦到底；扫不出（自定义脚本）则为空数组，
    // P1 会把它当「不覆盖」，回到 120s 探测窗口。
    registerWait({
      id: taskState.id,
      kind: "monitor",
      promise: { kind: "deadline", deadlineAt: taskState.deadlineAt },
      description,
      registeredAt: taskState.startTime,
      subjects: subjects.length > 0 ? subjects : undefined,
      // 登记归一化命令：下一个等待来判准入时要能认出「这是同一件事」
      command: normalizedCommand,
      // R1：P1 覆盖判定要用命令族，与 subjects 同源同尺
      commandFamilies: collectWaitCommandFamilies({ command }),
    });

    getLogger().info(
      "TOOL",
      `monitor ${taskState.id} 启动：${description}（期限 ${timeoutMs}ms，并发 ${countRunningMonitors()}/${effectiveMaxConcurrent}）`,
    );

    // R6：先起新的（上面 spawn + 登记），再停旧的。顺序不能反——中间的空窗会被 todo 闸门
    // 判成「没人会回来」而强推模型继续干活（ca8d7e5c 的形态）。
    const superseded =
      admission.action === "replace"
        ? supersedeReplacedWaits(admission.existing, taskState.id, "monitor")
        : [];

    const endAt = formatClockWithSeconds(taskState.deadlineAt);
    const minutes = Math.round(timeoutMs / 60_000);
    // D19（方案 §10.3）：无头形态（`-p` 单轮）没有 prompt 注入通道，事件没法在回合边界
    // 叫醒主循环，进程只能等到 monitor 结束再退出。不写这句时模型会按交互式的习惯
    // 说完「已启动，我先做别的」就收尾，用户拿到一个跑完即退的进程、看不到结果。
    // 判据复用唤醒登记的同一个事实（有没有注入通道），不另加「headless」全局标志；
    // stream-json 也有注入通道、同样等到结束，所以文案不绑定「无头」字样。
    const waitNote = isWakeupRegistrationEnabled()
      ? ""
      : "当前宿主在监控结束前不会退出，请等到监控结束后再收尾。\n";
    return {
      data:
        `已启动监控 ${taskState.id}（${description}），最晚 ${endAt} 结束（${minutes} 分钟期限）${clampNote}。\n` +
        `每条输出会作为通知送达，期间不需要查询状态，也不需要 sleep。\n` +
        `可以继续做不依赖它的工作；没有别的事就告诉用户在等什么，然后结束本轮。\n` +
        waitNote +
        `提前停止：task_stop ${taskState.id}${formatReplaceNote(superseded, taskState.id)}`,
    };
  }
}
