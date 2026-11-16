#!/usr/bin/env bun
/**
 * ci-retry-report —— 把「本轮 CI 重试了几条用例」变成看得见的一行（--retry 的唯一对冲）
 *
 * ## 为什么需要它
 *
 * 2026-11-15 起 `ci.yml` 的 macOS 分片带 `--retry=1`（理由与代价见 ci.yml matrix 上方注释）。
 * `--retry` 的核心风险是**会掩盖真回归**：一个只在特定时序下复现的真 bug，重试后偶发通过
 * 就会变绿，而 PR 页面上只有一片绿，没人知道刚才红过一次。
 *
 * 方案文档把这条写成了硬前提：「重试次数必须进遥测，否则『重试了多少次』永远不可见」。
 * 没有这一步就不该开 `--retry` —— 一个会静默吞掉失败的门禁，比没有门禁更危险。
 *
 * ## 为什么不用额外埋点
 *
 * 实测（2026-11-15，bun 1.4.2）确认 bun 自己就会在**重试过**的用例上打标记：
 *
 * ```text
 * (pass) flaky: 第一次失败第二次通过 (attempt 2)
 * (fail) always fail (attempt 2)
 * ```
 *
 * 所以不需要给测试加任何东西，解析 `bun test` 的输出即可。转绿与终败两种结论都带
 * `(attempt N)`，因此这份报告同时覆盖「被重试救回来的」和「重试也没救回来的」。
 *
 * ## 三条行为约定
 *
 * 1. **绝不让 CI 因此变红**。它的职责是「报告」，不是「门禁」：日志缺失、格式变化、
 *    零重试都要正常退出 0。把它做成阻断项的结果只会是有人给它加 `|| true`，
 *    然后连报告都不看了（与 northstar 版本快照同一条理由）。
 * 2. **有重试时发 `::warning::`**。stdout 在 CI 日志里要翻很久才看得到，
 *    annotation 会直接出现在 checks 页 —— 「有重试」这件事需要被看见。
 * 3. **没有日志文件 ≠ 没重试，是「不知道」**。两者必须区分开打印，否则
 *    「测试步骤因超时被杀、日志没落盘」会被误读成「一条重试都没有」。
 */

import { existsSync, readFileSync } from "node:fs";

/** 一条被重试过的用例（bun 只对它打 `(attempt N)`，N >= 2）。 */
export interface RetryHit {
  /** 用例全名（describe > test 的拼接结果，bun 原样输出） */
  name: string;
  /**
   * 该用例所属的测试文件（bun 在每组用例前单独打一行 `path/to/x.test.ts:`）。
   *
   * 为什么必须带：报告的唯一用途是「判断某个具体测试文件有没有复发」。
   * 只有用例名时，`T10b：墙钟总预算 > 不白占一格预算 (attempt 2)` 这条记录
   * 无法反查是哪个文件 —— 与 `ci-flake-stats.ts`「分不出文件」是同一个毛病，
   * 只是换了一层（2026-11-16 复核 max-duration flake 收尾判据时发现）。
   * 日志里认不出文件头行时为 undefined，报告会标成 `(未知文件)`，不静默留白。
   */
  file?: string;
  /** 重试之后的**最终**结论 */
  outcome: "pass" | "fail";
  /** 总尝试次数（bun 输出里的 N；N=2 表示首次失败、第二次通过/再失败） */
  attempt: number;
}

/**
 * ANSI 转义序列。
 *
 * 需要剥掉的理由：`bun test` 在 CI 里经 `tee` 落盘时**仍会带颜色**（bun 判断的是
 * 自己 stdout 是不是 TTY，而管道场景它并不总是关掉颜色），带色的行用肉眼看着正常，
 * 直接对首字符做 `^\(` 匹配却会漏。
 */
// eslint-disable-next-line no-control-regex -- 就是要匹配 ESC 字符本身
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * bun 打印的「文件分组头」：`packages/core/tests/query/max-duration-budget.test.ts:`
 *
 * 实测形态（bun 1.4.2）：无缩进、整行只有路径 + 冒号，位置在该文件第一条用例之前。
 * 放宽到「整行只有路径」是为了容忍未来 bun 给带缩进的形态；但它**不会**误吃用例行 ——
 * 用例行行首是 `(pass)` / `(fail)`，永远不会以路径开头。
 */
const FILE_HEADER = /^\s*(\S+\.(?:test|spec)\.(?:[cm]?[jt]sx?)):\s*$/;

/**
 * 从 bun test 的完整输出里挑出所有被重试过的用例。
 *
 * 只认行首的 `(pass)` / `(fail)` + 行内 `(attempt N)`：
 * - 不带 `(attempt N)` 的行是首次即通过的用例，不是重试，忽略；
 * - 行内的 `error:` / 断言快照等其它文本不参与匹配，避免把用例正文里恰好写了
 *   `(attempt 2)` 的字符串当成标记（要求行首结论才是标记位）。
 *
 * 同时跟踪文件分组头，把每条重试用例归到它所属的 `.test.ts` 上（见 `RetryHit.file`）。
 *
 * ⚠️ `(attempt N)` 必须**在行尾**（后面只允许跟可选的 `[12.34ms]` 时长）：
 * 真实 bun 输出就是这个形态，而放宽成「行内任意位置」会让
 * `(pass) 解析 (attempt 2) 这个字符串 [0.01ms]` 这类用例名被误判成重试
 * （2026-11-15 写测试时实测到，非迁就测试而是收紧到真实形态）。
 */
export function parseRetryLines(log: string): RetryHit[] {
  const hits: RetryHit[] = [];
  let currentFile: string | undefined;
  for (const raw of log.split("\n")) {
    const line = raw.replace(ANSI, "");
    const fileMatch = FILE_HEADER.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }
    // 行首必须就是结论标记；`(attempt N)` 后只允许可选的 `[时长]` 或行尾。
    const m = /^\((pass|fail)\)\s+(.+?)\s+\(attempt\s+(\d+)\)(?:\s+\[[^\]]*\])?\s*$/.exec(line);
    if (!m) continue;
    const attempt = Number(m[3]);
    if (!Number.isFinite(attempt) || attempt < 2) continue;
    hits.push({ name: m[2], file: currentFile, outcome: m[1] as "pass" | "fail", attempt });
  }
  return hits;
}

/** 报告里用的文件列：认不出文件头行时明确标出来，不留空（留空会被读成「没有文件」）。 */
function fileCell(hit: RetryHit): string {
  return (hit.file ?? "(未知文件)").replace(/\|/g, "\\|");
}

/** 报告要打印的文本（纯函数，便于测试直接断言）。 */
export function formatReport(hits: RetryHit[]): string {
  if (hits.length === 0) {
    return "✅ 本轮无重试用例（没有任何用例输出 (attempt N)，N≥2）";
  }

  // 被重试救回来的 vs 重试也没救回来的，分开数：
  // 前者是「flake 被兜住」的直接证据，后者说明 --retry 没帮上忙（多半是真失败）。
  const rescued = hits.filter((h) => h.outcome === "pass");
  const stillFailing = hits.filter((h) => h.outcome === "fail");

  const lines: string[] = [];
  lines.push(`⚠️ 本轮有 ${hits.length} 条用例被重试（--retry 掩盖真回归的唯一对冲就是这份报告）`);
  lines.push(`   · 重试后通过：${rescued.length} 条（若不加重试，这些会让本 job 变红）`);
  lines.push(`   · 重试后仍失败：${stillFailing.length} 条（--retry 没帮上忙，优先按真失败查）`);

  // 按文件汇总：判「某个文件有没有复发」时要一行看到它，不用去表格里逐条认用例名。
  const byFile = new Map<string, number>();
  for (const h of hits) {
    const key = h.file ?? "(未知文件)";
    byFile.set(key, (byFile.get(key) ?? 0) + 1);
  }
  lines.push("");
  lines.push("按文件：");
  for (const [file, count] of byFile) {
    lines.push(`   · ${file}：${count} 条`);
  }

  lines.push("");
  lines.push("| 文件 | 用例 | 最终结论 | 尝试次数 |");
  lines.push("| --- | --- | --- | --- |");
  for (const h of hits) {
    // 表格里 `|` 会破坏列，用例名里的竖线替换掉（保留可读性）
    lines.push(
      `| ${fileCell(h)} | ${h.name.replace(/\|/g, "\\|")} | ${h.outcome} | ${h.attempt} |`,
    );
  }
  return lines.join("\n");
}

/** CLI：`bun run scripts/ci-retry-report.ts <日志路径>`（缺参时读 stdin）。 */
async function main(): Promise<void> {
  const path = process.argv[2];
  let log: string;

  if (path) {
    if (!existsSync(path)) {
      // 「没有日志」不等于「没有重试」：测试步骤可能因超时被杀、tee 没写完。
      // 明确区分这两种状态，避免把它读成「一条重试都没有」。
      console.log(
        `ℹ️ 日志文件不存在（${path}）—— 无法判断本轮是否发生重试。` +
          "常见原因是测试步骤超时被杀、tee 没写完；这不代表「零重试」。",
      );
      return;
    }
    log = readFileSync(path, "utf8");
  } else {
    log = await new Response(Bun.stdin.stream()).text();
  }

  const hits = parseRetryLines(log);
  console.log(formatReport(hits));

  // 有重试就发 annotation：stdout 在 CI 日志里要翻很久，checks 页上要能直接看见。
  // 重试后仍失败的用例逐条点名 —— 它们最可能是真回归。
  // ⚠️ 点名必须带文件名：checks 页上只有用例名时，判不出是哪个文件复发。
  if (hits.length > 0) {
    const stillFailing = hits.filter((h) => h.outcome === "fail");
    const locate = (h: RetryHit) => (h.file ? `${h.file} > ${h.name}` : h.name);
    const detail =
      stillFailing.length > 0
        ? `；其中 ${stillFailing.length} 条重试后仍失败：${stillFailing.map(locate).join(" / ")}`
        : `；全部在重试后通过（flaky，未阻塞本轮）`;
    console.log(
      `::warning::本轮有 ${hits.length} 条用例被重试（--retry=1）${detail}。` +
        "重试会掩盖真回归，请确认这些用例不是稳定失败。",
    );
  }
}

if (import.meta.main) {
  await main();
}
