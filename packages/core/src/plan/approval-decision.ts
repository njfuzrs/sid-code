/**
 * 计划审批决策串的解析（M5，2026-11-15）。
 *
 * ## 为什么要把它抽成一个纯函数
 *
 * 审批对话框原来只回一个 `"approve"`，走哪个权限模式由 `deactivatePlanMode()` 里的
 * `getPrePlanMode() || "default"` 隐式决定——用户批准完才发现自己回到了 default，
 * 每次 edit 都要再按一遍确认，而他在批准框里没有任何表达机会。
 *
 * 现在对话框回的是 `approve:<acceptEdits|auto|previous>`，**执行模式变成用户当场的选择**。
 * 解析它有四处容易出错的地方，所以从 `app.ts` 的私有方法里提出来做成纯函数：
 *
 * 1. **不能只认 `"approve"`**：裸串仍然要能过（外部构造的旧决策、`planExecMode`
 *    无头路径），因此 `approve` 与 `approve:*` 都算批准。
 * 2. **非法模式不能让审批失败**：对话框被脚本/测试/未来版本构造出一个本版不认识的值时，
 *    正确行为是「按更保守的那个执行」= 沿用进入前的模式，而不是抛错或静默批准到某个
 *    更高权限档位。`rejectedMode` 只用于日志与单测断言，不参与控制流。
 * 3. **企业策略优先于用户选择**：`disabledModes` 禁掉的档位，选了也必须落到 null
 *    （沿用进入前的模式），否则等于开了个「对话框绕过企业策略」的后门。
 * 4. **`plan` 不是合法的执行模式**：批准之后留在 plan 里是语义自相矛盾，
 *    与 `--plan-exec-mode` 的 schema 校验（排除 plan）保持同一口径。
 *
 * @param raw 对话框（或宿主）返回的原始决策串
 */
import { isModeDisabledByPolicy } from "../permission/mode-policy.ts";

/** 批准后可以切到的执行模式；`null` 表示沿用进入 plan 之前的模式 */
export type PlanApprovalExecMode = "acceptEdits" | "auto" | null;

export interface PlanApprovalDecision {
  kind: "approve" | "reject" | "cancel";
  /** 仅 kind==="approve" 时有意义 */
  execMode: PlanApprovalExecMode;
  /** 仅 kind==="reject" 时有意义 */
  feedback: string;
  /**
   * 用户/宿主请求了、但被本地校验拒掉的模式原文。
   *
   * 存在的唯一理由是「可观测」：`execMode` 落成 null 时，日志里必须能看出是
   * 「本来就要沿用」还是「选了个不合法的值被降级」，否则线上排查时这两种情况长得一模一样。
   */
  rejectedMode?: string;
}

/** 批准合法可切的模式（白名单，`plan` 刻意不在其中） */
const APPROVABLE_MODES = new Set<string>(["acceptEdits", "auto"]);

/**
 * `approve:<mode>` 里的 mode 是否真的可以在批准后切过去。
 * 非法值、`plan`、被企业策略禁用的档位都返回 false。
 */
export function isApprovableExecMode(mode: string): boolean {
  if (!APPROVABLE_MODES.has(mode)) return false;
  return !isModeDisabledByPolicy(mode);
}

/**
 * 解析审批决策串。
 *
 * 形态（与 `DialogManager` 的 PlanApprovalDialog 一一对应）：
 * - `approve` / `approve:previous` → 批准，沿用进入前的模式
 * - `approve:acceptEdits` / `approve:auto` → 批准并切到该模式（被策略禁用时降级为沿用）
 * - `reject` / `reject:<feedback>` → 拒绝（可带修改意见）
 * - `cancel` → 取消（退出计划模式）
 * - 其它任意值 → 按拒绝处理（与抽函数之前的 else 分支同口径，不新增一种「未知」状态）
 */
export function parsePlanApprovalDecision(raw: string): PlanApprovalDecision {
  if (raw === "approve") {
    return { kind: "approve", execMode: null, feedback: "" };
  }

  if (raw.startsWith("approve:")) {
    const mode = raw.slice("approve:".length).trim();
    // "previous" 是对话框里「沿用进入前的模式」那一项，落到 null 由
    // deactivatePlanMode 的 getPrePlanMode() 接管
    if (mode === "" || mode === "previous") {
      return { kind: "approve", execMode: null, feedback: "" };
    }
    if (!isApprovableExecMode(mode)) {
      return { kind: "approve", execMode: null, feedback: "", rejectedMode: mode };
    }
    return { kind: "approve", execMode: mode as "acceptEdits" | "auto", feedback: "" };
  }

  if (raw === "cancel") {
    return { kind: "cancel", execMode: null, feedback: "" };
  }

  const feedback = raw.startsWith("reject:") ? raw.slice("reject:".length).trim() : "";
  return { kind: "reject", execMode: null, feedback };
}
