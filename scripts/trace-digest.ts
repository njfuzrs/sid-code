#!/usr/bin/env bun
/**
 * trace-digest —— sid-code 可观测性"一键嚼碎"CLI 脚本
 *
 * 核心逻辑在 src/trace/digest.ts(与内置 /trace 命令共用同一份),本文件只做 CLI 包装:
 * 解析 argv、按 TTY 决定是否着色、把 digest 模块的提示打到 stderr、结果打到 stdout。
 *
 * 用法:
 *   bun scripts/trace-digest.ts                  # 摘要最近一次会话
 *   bun scripts/trace-digest.ts latest           # 同上
 *   bun scripts/trace-digest.ts <sessionId>      # 指定会话(支持前缀,如 54c2)
 *   bun scripts/trace-digest.ts --list           # 列出最近 20 个会话(供挑选)
 *   bun scripts/trace-digest.ts <id> --json      # 机器可读 JSON(给上层程序用)
 *   bun scripts/trace-digest.ts <id> --full      # 附带更多思维链/工具参数细节
 */

import {
  resolvePaths,
  listSessions,
  resolveSession,
  buildDigest,
  renderHuman,
  renderList,
} from "../src/trace/digest.ts";

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positional = args.filter((a) => !a.startsWith("--"));
  const json = flags.has("--json");
  const full = flags.has("--full");
  const noColor = !process.stdout.isTTY || !!process.env.NO_COLOR;
  const invocation = "bun scripts/trace-digest.ts";

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

main();
