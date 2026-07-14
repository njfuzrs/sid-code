/**
 * 编译产物自检（方向 0：二进制编译自检护栏）
 *
 * 背景（根因分析-commit任务git状态快照冻结死循环.md 第 2 环）：
 * `bun build --compile` 在**编译时**把源码内联进二进制。git pull / commit 更新了源码后，
 * 磁盘上的二进制不会跟着变——若忘了 `make rebuild`，跑的还是旧逻辑。那次 git-status
 * 快照冻结死循环的**直接触发因素**，正是"源码已含方向 1 修复（3a63743），但运行的二进制
 * 编译自更早提交"，导致 system prompt 里注入的还是无锚点的旧格式快照。
 *
 * 本模块让**二进制自己**跑一遍关键代码路径并断言修复已内联。`make build` / `make rebuild`
 * 末尾调用 `<binary> --self-check`：编译出的产物一旦缺失关键修复就当场以非零码失败，
 * 把"源码有修复但二进制没重编"这个隐形发布陷阱变成显式的、构建期就暴露的硬错误。
 *
 * 设计原则：只校验**高价值、易因漏重编而回归**的不变量，逐条独立报告，避免变成
 * 什么都塞的"全量健康检查"。当前覆盖：
 *   1. git-status 仲裁锚点（方向 1）：generateGitStatusAttachment 输出必须含"启动快照"锚点句。
 *   2. 无进展止损阀（方向 2/4/6）：repeated-readonly-guard 的探查命令识别与卡住判定生效。
 */

/** 单条自检结果。 */
interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** git-status 仲裁锚点必须包含的三段关键文案（与 attachments.ts / 哨兵单测同源）。 */
const GIT_STATUS_ANCHOR_MARKERS = [
  "snapshot in time",
  "will not update during the conversation",
  "以 bash 工具执行 `git status` 的返回为准",
];

/**
 * 校验 1：git-status 仲裁锚点已内联。
 *
 * 直接调用编译进二进制的 generateGitStatusAttachment，检查输出是否含锚点句。
 * 非 git 仓库时返回 null——此时跳过（视为通过），因为无法构造输出，且构建机通常在 git 仓库内。
 */
async function checkGitStatusAnchor(): Promise<CheckResult> {
  const name = "git-status 仲裁锚点（方向 1）";
  try {
    const { generateGitStatusAttachment } = await import("../config/attachments.ts");
    const att = generateGitStatusAttachment(process.cwd());
    if (!att) {
      return { name, ok: true, detail: "跳过（当前目录非 git 仓库，无法构造输出）" };
    }
    const missing = GIT_STATUS_ANCHOR_MARKERS.filter((m) => !att.content.includes(m));
    if (missing.length > 0) {
      return {
        name,
        ok: false,
        detail:
          `git-status 块缺少仲裁锚点文案：${missing.map((m) => `"${m}"`).join("、")}。` +
          `这几乎可以断定二进制编译自方向 1 修复之前——请重新 make rebuild。`,
      };
    }
    return { name, ok: true, detail: "锚点句齐全" };
  } catch (e: any) {
    return { name, ok: false, detail: `执行异常：${e?.message ?? String(e)}` };
  }
}

/**
 * 校验 2：无进展只读命令止损阀已内联且逻辑生效。
 *
 * 用一组确定性输入驱动 repeated-readonly-guard 的纯函数，断言：
 *   - git status 被识别为只读探查命令；
 *   - 连续相同 (命令,输出) 达阈值后判定 stuck 并给出 remind 动作。
 */
async function checkStuckGuard(): Promise<CheckResult> {
  const name = "无进展止损阀（方向 2/4/6）";
  try {
    const {
      isReadonlyProbeCommand,
      processObservation,
      createRepeatedReadonlyState,
      STUCK_REPEAT_THRESHOLD,
    } = await import("../query/repeated-readonly-guard.ts");

    if (!isReadonlyProbeCommand("git status --short")) {
      return { name, ok: false, detail: "git status 未被识别为只读探查命令" };
    }

    const state = createRepeatedReadonlyState();
    let lastAction = "none";
    // 连续投喂 STUCK_REPEAT_THRESHOLD 次完全相同的空返回 git status。
    for (let i = 0; i < STUCK_REPEAT_THRESHOLD; i++) {
      const d = processObservation(state, [{ command: "git status --short", output: "" }], false);
      lastAction = d.action;
    }
    if (lastAction !== "remind") {
      return {
        name,
        ok: false,
        detail: `连续 ${STUCK_REPEAT_THRESHOLD} 次相同空跑后未触发 remind（实际 action=${lastAction}）`,
      };
    }
    return { name, ok: true, detail: "探查命令识别 + 卡住判定生效" };
  } catch (e: any) {
    return { name, ok: false, detail: `执行异常：${e?.message ?? String(e)}` };
  }
}

/**
 * 运行全部自检。返回 true=全部通过，false=至少一条失败。
 * 结果逐条打印到 stderr（便于 CI 日志抓取），不污染 stdout。
 */
export async function runSelfCheck(): Promise<boolean> {
  const results = await Promise.all([checkGitStatusAnchor(), checkStuckGuard()]);
  let allOk = true;
  console.error("── sid-code 编译产物自检 ──");
  for (const r of results) {
    const mark = r.ok ? "✓" : "✗";
    console.error(`  ${mark} ${r.name}：${r.detail}`);
    if (!r.ok) allOk = false;
  }
  if (allOk) {
    console.error("自检通过：关键修复已内联进二进制。");
  } else {
    console.error("自检失败：二进制缺失关键修复。若刚改过相关源码，请重新 `make rebuild`。");
  }
  return allOk;
}
