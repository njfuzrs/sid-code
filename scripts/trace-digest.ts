#!/usr/bin/env bun
/**
 * trace-digest —— sid-code 可观测性"一键嚼碎"CLI 脚本
 *
 * 核心逻辑在 packages/core/src/trace/digest.ts(与内置 /trace 命令共用同一份),本文件只做 CLI 包装:
 * 解析 argv、按 TTY 决定是否着色、把 digest 模块的提示打到 stderr、结果打到 stdout。
 *
 * 用法:
 *   bun scripts/trace-digest.ts                  # 摘要最近一次会话
 *   bun scripts/trace-digest.ts latest           # 同上
 *   bun scripts/trace-digest.ts <sessionId>      # 指定会话(支持前缀,如 54c2)
 *   bun scripts/trace-digest.ts --list           # 列出最近 20 个会话(供挑选)
 *   bun scripts/trace-digest.ts <id> --json      # 机器可读 JSON(给上层程序用)
 *   bun scripts/trace-digest.ts <id> --full      # 附带更多思维链/工具参数细节
 *   bun scripts/trace-digest.ts --cache          # 跨会话缓存命中率/省钱/断裂归因(P2-4)
 *   bun scripts/trace-digest.ts --cache --days 7 # 同上,只看最近 N 天
 *   bun scripts/trace-digest.ts --health         # 跨会话 Provider 健康度看板(P2-7)
 *   bun scripts/trace-digest.ts --health --period 7d  # 同上,指定周期(1h|24h|7d,默认 24h)
 *
 * 注:--cache 与 --health 在产品内也可达(/trace --cache、/trace --health),
 * 不必为看这两个视图回到仓库跑脚本。
 */

import {
  resolvePaths,
  listSessions,
  resolveSession,
  buildDigest,
  renderHuman,
  renderList,
} from "@sid-code/core/trace/digest.ts";
import { renderCacheSection } from "@sid-code/core/trace/cache-report.ts";
import {
  aggregateProviderHealth,
  renderHealthText,
} from "@sid-code/core/telemetry/provider-health.ts";

/**
 * P2-7：本脚本认得的全部 flag。
 *
 * **必须与下方所有 `flags.has(...)` / `args.indexOf("--...")` 的实参完全一致** ——
 * 由 `tests/scripts/trace-digest-flags.test.ts` 双向对账（任一侧新增漏改就红）。
 *
 * 这份清单存在的理由不是"文档化"，而是让**未识别 flag 变成硬错误**：
 * 此前脚本对未知 flag 静默忽略，于是 `--health` 漏接了却表现为"打印最近一次会话的
 * 摘要"——不报错、不提示，头注释还写着这个 flag 可用。修掉具体的 `--health` 而不修
 * 这个静默行为，下一个漏接的 flag 会以完全相同的方式潜伏。
 */
export const KNOWN_FLAGS = new Set([
  "--json",
  "--full",
  "--list",
  "--cache",
  "--health",
  "--days",
  "--period",
]);

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positional = args.filter((a) => !a.startsWith("--"));
  const json = flags.has("--json");
  const full = flags.has("--full");
  const noColor = !process.stdout.isTTY || !!process.env.NO_COLOR;
  const invocation = "bun scripts/trace-digest.ts";

  // P2-7：未识别 flag 兜底。**必须早退而不是仅告警** —— 只打一行 stderr 而继续
  // 跑下去，输出的仍然是"用户没要的那个视图"，和静默忽略在结果上没有区别
  // （用户看到的是一份看似正常的摘要，而他要的是健康看板）。
  const unknown = [...flags].filter((f) => !KNOWN_FLAGS.has(f));
  if (unknown.length > 0) {
    process.stderr.write(
      `⚠ 未识别参数: ${unknown.join(" ")}\n` +
        `可用参数: ${[...KNOWN_FLAGS].join(" ")}\n` +
        `用法见文件头注释,或跑 ${invocation} --list 列出可用会话。\n`,
    );
    process.exitCode = 1;
    return;
  }

  const paths = resolvePaths();
  const all = listSessions(paths);

  if (flags.has("--list")) {
    if (all.length === 0) {
      process.stdout.write(`未找到任何会话轨迹。检查 ${paths.sessionsDir} 是否存在。\n`);
      return;
    }
    process.stdout.write(renderList(all, { noColor, invocation }) + "\n");
    return;
  }

  // P2-7：跨会话 Provider 健康度看板。渲染走 core 的 renderHealthText（= 无颜色的
  // renderHealthLines），与 /trace --health、scripts/provider-health.ts 同一份实现，
  // 所以三个入口逐行一致 —— 头注释早就写着这个 flag 可用，此前却漏接了。
  //
  // 与 --cache 同理放在 "no sessions" 早退**之前**：本视图跨会话聚合 events.jsonl，
  // 与"能不能解析出某一个会话的轨迹"无关。
  if (flags.has("--health")) {
    // --period 1h|24h|7d，默认 24h（与 /trace --health 的默认值一致）。
    // 注意 scripts/provider-health.ts 的默认是 1h —— 那是它自己的历史默认，
    // 本脚本对齐产品内的 /trace --health，因为这两个才是"同一个入口的两种到达方式"。
    const periodIdx = args.indexOf("--period");
    const periodRaw = periodIdx >= 0 ? args[periodIdx + 1] : undefined;
    if (periodRaw !== undefined && !/^(1h|24h|7d)$/.test(periodRaw)) {
      process.stderr.write(`⚠ 未知周期: ${periodRaw}，支持 1h|24h|7d\n`);
      process.exitCode = 1;
      return;
    }
    const periodMs = periodRaw === "1h" ? 3600_000 : periodRaw === "7d" ? 86400_000 * 7 : 86400_000;
    const report = aggregateProviderHealth({ periodMs });
    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      process.stdout.write(renderHealthText(report) + "\n");
    }
    return;
  }

  // P2-4：跨会话缓存视图。不依赖 trajectories（账本与 cache-breaks 是独立数据源），
  // 所以放在 "no sessions" 早退之前 —— trajectories 被 LRU 清掉后账本仍在，
  // 此时最需要的正是这个视图。
  if (flags.has("--cache")) {
    // --days N 限定窗口。`CacheReportOptions.sinceDays` 早就定义了，但两个入口
    // （本脚本与 /trace --cache）此前都没接 —— 字段可达性为零等于没这个功能。
    const daysIdx = args.indexOf("--days");
    const daysRaw = daysIdx >= 0 ? args[daysIdx + 1] : undefined;
    const sinceDays = daysRaw && /^\d+$/.test(daysRaw) ? parseInt(daysRaw, 10) : undefined;
    const report = renderCacheSection({ noColor, json, sinceDays });
    process.stdout.write(report + "\n");
    return;
  }

  if (all.length === 0) {
    process.stderr.write(
      `未找到任何会话轨迹 (${paths.sessionsDir})。\n` +
        `可能原因: 还没跑过 sid-code,或 SID_CODE_HOME 指向了别处。\n`,
    );
    process.exitCode = 1;
    return;
  }

  const { ref, warning } = resolveSession(positional[0], all);
  if (warning) process.stderr.write(`⚠ ${warning}\n`);
  if (!ref) {
    process.stderr.write(`未找到 session "${positional[0]}"。用 --list 看可用会话,或用 latest。\n`);
    process.exitCode = 1;
    return;
  }

  const digest = buildDigest(ref, full, paths);
  if (!digest) {
    process.stderr.write(`无法解析 ${ref.trajPath}(文件损坏?)\n`);
    process.exitCode = 1;
    return;
  }

  if (json) {
    process.stdout.write(JSON.stringify(digest, null, 2) + "\n");
  } else {
    process.stdout.write(renderHuman(digest, { noColor, invocation }) + "\n");
  }
}

// P2-7：只在"被当作脚本直接执行"时跑 main()。
//
// 加这道判断的理由很具体：flag 对账测试（tests/scripts/trace-digest-flags.test.ts）
// 需要 import 本文件读 KNOWN_FLAGS —— 而 import 一个顶层就调 main() 的模块，会让测试
// 顺手把**真实**的最近一次会话摘要打进测试输出（实测确实发生了）。测试仍然全绿，
// 但输出里混进一大段真实轨迹，且 process.exitCode 会被 main() 改掉。
if (import.meta.main) main();
