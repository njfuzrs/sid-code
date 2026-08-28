/**
 * 门禁：`exec-swebench.sh` 取 allowlist 代理 IP 时，判据必须是「像一个 IPv4」，
 * **不能是「非空」**。
 *
 * ## 为什么值得一条独立门禁：它烧掉过整整一轮跨 harness 对照
 *
 * `docker inspect` 对一个**已停止**的容器**不报错**。它按 Go 模板求值，
 * 网络已解绑时 `(index .NetworkSettings.Networks "net").IPAddress`
 * 打印字符串 **`invalid IP`**，并且 **exit 0**。
 *
 * 于是「非空」判据为真、门禁放行，`http_proxy=http://invalid IP:8080`
 * 被注进每一个 agent 容器。实测（2026-08-28，路 B 我方侧，
 * `runs/routeb-sid80-aborted-proxy-down/`）：10 条实例**逐条**
 * `agent_error patch=0B wall=11–17s`、`api_calls=0`，agent.log 里是
 * `LLM 错误: … Connection error.`。
 *
 * **危险的不是失败，是失败的形状**：outcome 是 `agent_error`、
 * unaccounted 写「原因未归因，需人工确认**是否为能力问题**」——
 * 一份 solved_count=0 的报告照常生成，而唯一指向真因的证据是
 * `代理=invalid IP:8080` 那一行里的两个字，混在十几行门禁输出中间。
 *
 * ## 为什么这条测试是「读脚本文本」而不是「跑脚本」
 *
 * 要真跑就得起 docker、停掉代理容器、再跑一遍 —— 那是分钟级且依赖本机 daemon，
 * 在 CI 上必然 skip，而**恒 skip 的门禁等于没有门禁**
 * （同记忆里「门禁不许依赖可选依赖，否则 CI 恒 skip」那条）。
 * 所以判据下沉到「那一行判据长什么样」这个静态形态上：它能机械回答
 * 「有人把它改回 `-n` 了吗」，而这正是唯一需要防的漂移。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const SCRIPT = join(REPO_ROOT, "evals/external-benchmarks/swe-bench/exec-swebench.sh");

/** 取代理 IP 那一段（从 `local proxy_ip` 到它后面的判据块）。 */
function proxyGuardBlock(src: string): string {
  const start = src.indexOf("local proxy_ip=");
  expect(start).toBeGreaterThan(-1);
  // 判据块紧随其后，200 行足够覆盖且不会把无关代码吃进来。
  return src.slice(start, start + 1200);
}

describe("exec-swebench.sh 代理 IP 判据", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const block = proxyGuardBlock(src);

  test("判据是 IPv4 形态匹配，不是「非空」", () => {
    // 必须出现四段点分数字的正则。这是白名单式判据：覆盖全部未知坏值，
    // 而不是照着见过的那一个坏值（`invalid IP`）写黑名单。
    expect(block).toMatch(/\[0-9\]\{1,3\}\\\.\[0-9\]\{1,3\}/);
  });

  test('不许把判据改回 `[[ -n "$proxy_ip" ]]`', () => {
    // 变异自证的目标就是这一条：把判据改回 `-n` 时它必须翻红。
    expect(block).not.toMatch(/\[\[\s*-n\s*"?\$\{?proxy_ip\}?"?\s*\]\]/);
  });

  test("报错信息要打印拿到的坏值本身", () => {
    // 不打印坏值时，人看到的是「取不到 IP」，会去查 net-setup；
    // 打印出来才会看见 `invalid IP` 这两个字，进而去看容器状态。
    expect(block).toMatch(/\$\{proxy_ip\}/);
  });

  test("报错信息要点破「容器停掉时 docker inspect 返回 invalid IP 且 exit 0」", () => {
    // 这条是给下一个踩到的人留的归因线索 —— 没有它，
    // 「非空判据为什么不够」这件事又要重新排查一遍。
    expect(block).toContain("invalid IP");
  });
});
