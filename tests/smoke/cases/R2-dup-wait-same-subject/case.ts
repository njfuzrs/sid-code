/**
 * R2 同一对象的第二个等待不重复启动（事故 20261112 的 b0aa0f1e 形态）。
 *
 * 事故形状（真实轨迹，人工核过）：
 * - 10:55:31 / 10:55:52 / 10:56:04 / 10:56:17 四次 `bash /tmp/wait-pr-779.sh`
 *   （`run_in_background` + `wait_until_seconds`），四个进程同时在跑；
 * - 四个 `WaitRegistered` 的 `description` 逐字相同，四份脚本 11:00 前后各自以退出码 1
 *   结束、**各送一条通知**；
 * - 没有任何一条工具回执提到「已有等待在盯同一个对象」。
 *
 * 判据（方案 §R2 验收 2）：整段只有 **1 个** shell 任务被 spawn，另外 3 次工具回执含
 * 「本次未重复启动」。期望来源是方案 §1.4 / §R2 里人工核过的轨迹数字，不是从实现反推的。
 *
 * 为什么脚本里用 `# gh pr checks 779` 注释而不是真的调 gh：对象签名来自**脚本正文**
 * （`bash xxx.sh` 的命令行上什么都看不出，8b8d721f 的形态），而回放环境没有 gh 可调。
 * 注释与真实脚本里的 `gh pr checks "$pr"` 走同一套抽取（宽松正则 + 变量展开）。
 *
 * 时长：`wait_until_seconds` 的下限是 60s，第一次 spawn 的等待要活到第 4 次调用结束，
 * 因此用例至少要跑满一次期限（`timeoutMs` 覆盖运行器缺省的 60s 单例超时）。
 */
import { TASK_LIFECYCLE_EVENT_NAME } from "@sid-code/core/task/lifecycle.ts";
import { WAIT_REGISTERED_EVENT_NAME } from "@sid-code/core/task/index.ts";
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "R2-dup-wait-same-subject",
  ledger: "R2",
  feature: "等待态：同一对象只允许一个等待",
  kind: "guard",
  repo: {
    "README.md": "R2：同一对象的第二个等待不该再起进程\n",
    "wait-pr-779.sh": "#!/bin/sh\n# gh pr checks 779\nwhile true; do sleep 5; done\n",
  },
  argv: ["-p", "等 PR 779 的 CI 过了告诉我"],
  timeoutMs: 150_000,
  expect: {
    events: [
      // 只登记了一次等待：后三次被按对象单活约束挡在 spawn 之前
      { event: WAIT_REGISTERED_EVENT_NAME, where: { kind: "shell" }, count: 1 },
      // 只起了一个后台进程（四个进程各送一条通知，就是 b0aa0f1e 的 4 条噪音）
      {
        event: TASK_LIFECYCLE_EVENT_NAME,
        where: { task_type: "local_shell", phase: "started" },
        count: 1,
      },
    ],
    output: (out) => {
      // 后三次的工具回执必须明说「本次未重复启动」，并给出停旧任务的出口；
      // 只做到「不启动」而不回执的话，模型会以为挂上了、一直等一条不会来的通知。
      const text = JSON.stringify(out.requests);
      if (!text.includes("本次未重复启动")) {
        return "重复的三次等待没有返回「本次未重复启动」回执——同对象去重没有生效";
      }
      if (!text.includes("task_stop")) {
        return "回执没有给出 task_stop 出口——模型改了脚本也换不了等法（R2 §修法 2）";
      }
      return null;
    },
  },
  mutations: [
    {
      file: "packages/core/src/task/wait-admission.ts",
      // 把「按对象查已有等待」整段废掉：判据恒 start，后三次照常 spawn
      find: "  const subjects = input.subjects ?? [];",
      replace: "  const subjects = (input.subjects ?? []).filter(() => false);",
      why: "准入判定恒 start，同一对象的四次等待全部 spawn（回到 b0aa0f1e 的形态）",
    },
  ],
};

export default def;
