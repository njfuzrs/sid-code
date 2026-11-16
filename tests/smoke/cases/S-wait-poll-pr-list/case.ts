/**
 * S-wait-poll-pr-list：等待期前台轮询 `gh pr list` 必须被计数并硬拦（方案 §7.3，PR-B）。
 *
 * ## 回放形状（人工核过的期望，不来自跑一遍实现）
 *
 * 1. 挂 monitor 跑 `bash watch.sh`（脚本正文里 `gh pr list --state open --limit 100`）；
 * 2. 同脚本再挂一次 → **duplicate**（P4：对象抽得到时走对象路径，抽不到时走命令 + hash）；
 * 3. 连续 20 次前台 `date '+%H:%M:%S' && gh pr list --state open --json number --limit 5`，
 *    fake `gh` 每次返回**递增编号** —— 于是 P1 的「结果没变」永远不成立，
 *    只有 P5 的计数能拦住第 15 次。这正是本用例要守的那一层（P1 单独存在时拦不住）。
 *
 * ## 期望（方案 §7.3 原文）
 *
 * - 第二次挂同脚本 monitor 返回 duplicate；
 * - fake `gh` 被前台调用次数 ≤ 14（第 15 次起不执行）；
 * - 出现 `WaitPollEscalated level:2`。
 *
 * ## 为什么 fake `gh` 由用例自己提供
 *
 * 回放环境没有 gh，也不能连真 GitHub。`PATH="<repo>/bin:$PATH" gh pr list …` 这种写法
 * 在命令表里仍被识别成 `gh`（`PATH=` 前缀不改变命令名），所以既能伪造输出、又不影响识别。
 * `bin/gh` 的调用日志写在用例仓里：**第 15 次及以后**才写 `gh-overflow.log`，
 * 用 `files: absent` 表达「≤ 14 次」——比数行数更直白，也不需要额外读文件的能力。
 *
 * 用例仓文件默认 644（运行器不 chmod），所以第一条回放先 `chmod +x bin/gh`。
 */
import {
  WAIT_POLL_ESCALATED_EVENT_NAME,
  WAIT_REGISTERED_EVENT_NAME,
} from "@sid-code/core/task/index.ts";
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "S-wait-poll-pr-list",
  ledger: "S-wait-poll",
  feature: "等待态：前台轮询 gh pr list 的计数与硬拦（P1/P4/P5 串起来）",
  kind: "guard",
  repo: {
    "README.md": "S-wait-poll-pr-list：等待期前台轮询的硬拦\n",
    // fake gh：--limit 100 是 monitor 后台脚本的调用（固定输出、不计数）；
    // 其余是前台轮询，每次返回递增编号，让 P1 的「结果没变」永远不成立。
    "bin/gh": `#!/bin/sh
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
case "$*" in
  *"--limit 100"*) echo '[]'; exit 0;;
esac
LOG="$ROOT/gh-calls.log"
touch "$LOG"
n=$(wc -l < "$LOG" | tr -d ' ')
if [ "$n" -ge 14 ]; then
  echo "$*" >> "$ROOT/gh-overflow.log"
fi
echo "$*" >> "$LOG"
printf '[{"number":%s}]\\n' "$((n + 1))"
`,
    // monitor 的脚本：对象写在正文里（P3），且它是 monitor 的 `command` 指向的文件
    "watch.sh": `#!/bin/bash
ROOT="$(cd "$(dirname "$0")" && pwd)"
prev=""
while true; do
  raw=$(PATH="$ROOT/bin:$PATH" gh pr list --state open --limit 100 --json number,mergeStateStatus 2>/dev/null)
  if [ "$raw" != "$prev" ]; then
    echo "[$(date +%H:%M)] open=$raw"
    prev="$raw"
  fi
  sleep 180
done
`,
  },
  argv: ["-p", "盯着 open PR，有变化告诉我"],
  timeoutMs: 120_000,
  expect: {
    events: [
      // 第二次挂同脚本被挡在 spawn 之前：只登记一个等待源
      { event: WAIT_REGISTERED_EVENT_NAME, where: { kind: "monitor" }, count: 1 },
      // P5 第 15 次起的硬拦事件：每段等待只落一次
      { event: WAIT_POLL_ESCALATED_EVENT_NAME, where: { level: 2 }, count: 1 },
    ],
    // 第 15 次及以后才会写这个文件 → absent 即「前台执行 ≤ 14 次」
    files: [{ path: "gh-overflow.log", absent: true }],
    output: (out) => {
      const text = JSON.stringify(out.requests);
      if (!text.includes("本次未重复启动")) {
        return "第二次挂同脚本 monitor 没有返回「本次未重复启动」——P4 的去重没有生效";
      }
      if (!text.includes("超过上限")) {
        return "第 15 次起的回执没有出现「超过上限」——P5 硬拦没有生效（P1 拦不住递增输出）";
      }
      if (!text.includes("task_stop")) {
        return "硬拦回执没有给出 task_stop 出口——模型被拦住却没有别的路可走";
      }
      return null;
    },
  },
  mutations: [
    {
      file: "packages/core/src/task/status-poll-guard.ts",
      find: "    if (escalation.count >= WAIT_POLL_BLOCK_AFTER) {",
      replace: "    if (false) {",
      why: "P5 硬拦整段失效：第 15 次之后照常执行 → fake gh 写出 gh-overflow.log",
    },
  ],
};

export default def;
