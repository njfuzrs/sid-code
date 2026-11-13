/**
 * R6：新起的等待淘汰盯同一对象的旧等待（事故 20261112 的 ca8d7e5c 形态）。
 *
 * 事故形状（真实轨迹，人工核过）：
 * - 11:04:51 起 `bash /tmp/wait-pr-780-merged.sh`（`wait_until_seconds` 1800，只等 MERGED）；
 * - 11:05:51 换了一种等法，起 `bash /tmp/wait-pr-780-logs.sh`（同对象 `gh:pr:780`，
 *   命令与脚本正文都变了 → 准入判 `replace`）；
 * - **旧的 sg36n1dwy 继续跑到自己的期限**，两条等待并行；旧任务到期后再送一条 killed 通知，
 *   模型（R3）把它误读成「PR 有了新结果」，回去前台重查。
 *
 * 判据（方案 §R6 验收 4）：整段有 **2 个** shell 启动（新旧各一），旧任务在第二个启动时
 * 立即进终态（`TaskLifecycle{completed, reason:"superseded"}`），且**没有**它的
 * delivered(killed)——被替换后不再送终态通知。
 *
 * 为什么 B 的脚本直接 `exit 0`：用例要断言「旧任务不被送通知」，就必须让新任务正常送达
 * 一条 completed 作为对照——否则 delivered 总数为 0 时，「A 没送达」与「整条投递链没跑」
 * 分不开。
 *
 * 期限的算术：准入的第二条判据是「新期限落在旧等待剩余期限之内 → duplicate」，
 * 所以 B 的 `wait_until_seconds` 必须**大于** A 的（1800 → 3600），才会判成 replace。
 *
 * 为什么 A 的期限远大于用例超时：变异自证要求「不淘汰旧任务」能被这个用例抓住。
 * 用 60s 时，A 到期也会产生 `completed(superseded)`（替换路径已经写好了标记），
 * 与「立即淘汰」在事件上无法区分——实测该 mutation 会 SURVIVED。拉到 1800s 后，
 * 没被淘汰的 A 会一直跑，用例在 120s 超时**红**，形态与真实事故一致（旧等待拖到期限）。
 */
import { TASK_LIFECYCLE_EVENT_NAME } from "@sid-code/core/task/lifecycle.ts";
import { WAIT_REGISTERED_EVENT_NAME } from "@sid-code/core/task/index.ts";
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "replace-wait-same-subject",
  ledger: "R6",
  feature: "等待态：换了等法时旧等待被淘汰",
  kind: "guard",
  repo: {
    "README.md": "R6：换了等法时旧等待不该继续跑\n",
    // A：只等合并结果，必须活着到被替换那一刻
    "wait-pr-780-merged.sh": "#!/bin/sh\n# 等待 PR #780 的 CI\nwhile true; do sleep 5; done\n",
    // B：换去盯日志，条件满足即成功退出（给用例一条 completed 的对照送达）
    "wait-pr-780-logs.sh": "#!/bin/sh\n# 等待 PR #780 的 CI\nexit 0\n",
  },
  argv: ["-p", "PR 780 合并后告诉我；顺便盯着它的 CI 日志"],
  timeoutMs: 120_000,
  expect: {
    events: [
      // 两次都真的起了进程：replace 的语义是「起新的」，不是像 duplicate 那样拦下
      {
        event: TASK_LIFECYCLE_EVENT_NAME,
        where: { task_type: "local_shell", phase: "started" },
        count: 2,
      },
      { event: WAIT_REGISTERED_EVENT_NAME, where: { kind: "shell" }, count: 2 },
      // 旧任务在第二个等待启动时立即终态，且原因可追溯（不是没有原因的 killed）
      {
        event: TASK_LIFECYCLE_EVENT_NAME,
        where: { phase: "completed", reason: "superseded" },
        count: 1,
      },
      // 旧任务不送终态通知：它的 killed delivered 一条都不该有。
      // 若通知抑制失效，这里会变成 1（A 的 killed 被注入），用例红。
      {
        event: TASK_LIFECYCLE_EVENT_NAME,
        where: { phase: "delivered", status: "killed" },
        count: 0,
      },
      // 对照：新任务正常送达一条 completed，证明投递链本身是通的
      {
        event: TASK_LIFECYCLE_EVENT_NAME,
        where: { phase: "delivered", status: "completed" },
        count: 1,
      },
    ],
    output: (out) => {
      const text = JSON.stringify(out.requests);
      if (!text.includes("已替换此前在盯同一对象的等待")) {
        return "替换回执没有说明旧等待已被替换——模型会以为两个都还在跑，或去前台重查";
      }
      if (!text.includes("不再送终态通知")) {
        return "回执没有说旧等待不再送通知——模型会继续等一条不会来的通知";
      }
      return null;
    },
  },
  mutations: [
    {
      file: "packages/core/src/task/wait-admission.ts",
      // 把「淘汰旧 shell」整段变成 no-op：旧任务继续跑到自己的期限
      find: "killShellTask(src.id, { summary: `已被 ${newId} 替换（同一对象换了等法，无需再等）` });",
      replace: "void src; // mutation: 不淘汰旧任务",
      why: "替换只起新的、不停旧的：旧 shell 继续跑，completed(superseded) 事件消失（回到 ca8d7e5c 的形态）",
    },
    {
      file: "packages/core/src/task/notification.ts",
      // 通知抑制失效：被替换任务的 killed 照常入队 → 会多一条 delivered(killed)
      find: "  if (isTerminalStatus(n.status) && getTask(n.taskId)?.supersededBy) return;",
      replace:
        "  if (false && isTerminalStatus(n.status) && getTask(n.taskId)?.supersededBy) return;",
      why: "被替换任务照常送终态通知：旧任务的 killed 会在下一轮送达（R3 误读的素材）",
    },
  ],
};

export default def;
