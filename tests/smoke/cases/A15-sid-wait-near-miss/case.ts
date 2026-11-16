/**
 * A15 `sid-wait` 近似形态在入口被拒，不产生「后台假成功」。
 *
 * 为什么值得一个 G2 用例：这条判据原本依赖「A2 上线后真实轨迹里不再出现拼接形态」，
 * 而日常使用中模型**很少**再写拼接形态（A2 上线后 4 次调用全是正确写法，
 * 被拒绝的真实样本为 0）——等真实数据等于永远等不到。harness 这一半是确定性的：
 * 给定模型写了拼接形态，入口必须当场拒绝且**不 spawn 任何任务**，这正好是 G2 该守的。
 *
 * 判据（取自排查文档 §八 第 1/2 层，不是从实现反推）：
 * - 回执含「必须单独成为整条命令」（模型能一句话纠正）；
 * - 不出现「命令已作为后台任务启动」——那正是假成功的入口；
 * - 没有 PostToolUse 成功事件（工具被判失败，而不是执行成功）。
 *
 * 反例形态的原样来源：本机轨迹 `2026-11-16T07:03:40Z` 那次
 * `sid-wait gh-pr 876; echo "sid-wait exit=$?"`（合并前最后一次拼接形态）。
 */
import { HookEventName } from "@sid-code/core/hook/types.ts";
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "A15-sid-wait-near-miss",
  ledger: "A15",
  feature: "sid-wait 近似形态入口拒绝",
  kind: "guard",
  repo: {
    "seed.txt": "smoke fixture\n",
  },
  argv: ["-p", '请用 bash 工具在后台等我确认 PR 779：sid-wait gh-pr 779; echo "EXIT=$?"'],
  expect: {
    events: [
      // 入口拒绝 = 工具软失败：落 PostToolUse(is_error:true)，**不是** PostToolUseFailure
      // （后者只留给权限拒绝 / hook 阻止 / 执行异常；工具自己返回 isError 走这里）。
      {
        event: HookEventName.PostToolUse,
        where: { tool_name: "bash", is_error: true },
        count: 1,
      },
      // 假成功的形态是「spawn 了普通后台任务 → 0 秒 completed、摘要『执行成功』」：
      // 那条路径会留下一条 PostToolUse(is_error:false)，所以这里必须是 0。
      {
        event: HookEventName.PostToolUse,
        where: { tool_name: "bash", is_error: false },
        count: 0,
      },
    ],
    output: (out) => {
      // 只在「拒绝没生效」时才会出现的字符串：后台任务的启动回执。
      // 判据来自排查文档 §八第 1 层「断言要看没有 spawn 任何进程，不只看返回文案」。
      const text = JSON.stringify(out.stdout ?? "");
      if (text.includes("命令已作为后台任务启动")) {
        return "仍然启动了后台任务——这正是「0 秒执行成功」的假成功形态";
      }
      return null;
    },
  },
  mutations: [
    {
      file: "packages/core/src/tool/bash.ts",
      find: "      if (sidWaitMisuse) {",
      replace: "      if (false) {",
      why: "去掉入口拒绝分支：拼接形态落回 shell，后台以末尾 echo 的 0 收尾 → 假成功",
    },
  ],
};

export default def;
