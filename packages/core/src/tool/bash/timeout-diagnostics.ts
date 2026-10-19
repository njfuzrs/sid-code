/**
 * Bash 前台超时诊断 —— 区分「命令真的慢」与「命令根本不会自己退出」
 *
 * 缺陷来源：会话 20261019-163503-c0e3e484。模型跑
 * `pnpm -r test:unit > /tmp/all-unit.txt 2>&1`，而 `test:unit` 是裸 `vitest`，
 * 非 CI 环境下跑完即进入 watch 模式（`Waiting for file changes...`），进程永不退出。
 * 600s 超时后旧提示只有两句：
 *   - 「如需长时间运行，请用 run_in_background=true 重试」——对不会退出的命令是错药，
 *     模型照做后后台任务同样挂住，最后靠 task_stop 杀掉；
 *   - 「部分输出: (命令无输出)」——输出全被重定向进文件，管道里确实为空，
 *     真正的线索（watch 提示）躺在 /tmp/all-unit.txt 里，模型看不到。
 *
 * 这里做两件只读的事：
 *   1. 输出为空时，回读命令里**写入类重定向目标**的尾部（只读、限长、只认绝对路径/~）；
 *   2. 在可见输出里识别「常驻/等待输入」特征，命中则明确告诉模型：改命令，不要转后台。
 *
 * 不做的事（见 Agent Note）：不往子进程注入 CI=1——会改变用户命令的语义（allowOnly、
 * 交互、颜色、部分工具的发布行为），属于用「更快」换「更准」，且对非 CI 感知的常驻进程无效。
 */

import { closeSync, fstatSync, openSync, readSync } from "fs";
import { homedir } from "os";
import { extractRedirectTargets, parseBashCommand } from "./parser.ts";

/** 每个重定向文件最多回读的尾部字节数（只给模型看线索，不是完整日志）。 */
const TAIL_BYTES = 2048;
/** 最多回读几个重定向目标，防止 `a > x; b > y; ...` 把提示撑爆。 */
const MAX_TAIL_FILES = 2;

/**
 * 常驻 / 等待输入的输出特征。只收**原文稳定且不会出现在正常结束输出里**的短语，
 * 避免把「真的慢」误判成「不会退出」（那会把模型从正确的 run_in_background 引开）。
 */
const NON_TERMINATING_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  // vitest / jest watch
  { re: /Waiting for file changes/i, label: "测试框架 watch 模式（vitest/jest）" },
  { re: /press h to show help, press q to quit/i, label: "测试框架 watch 模式（vitest）" },
  { re: /Watch Usage/i, label: "测试框架 watch 模式（jest）" },
  // tsc / webpack / nodemon / 通用 watcher
  { re: /Watching for file changes/i, label: "编译器/构建工具 watch 模式" },
  { re: /\[nodemon\] watching/i, label: "nodemon 监听模式" },
  // dev server
  { re: /Local:\s+https?:\/\/(?:localhost|127\.0\.0\.1)/i, label: "开发服务器（常驻进程）" },
  { re: /ready in \d+(?:\.\d+)?\s*ms/i, label: "开发服务器（常驻进程）" },
  // 交互式等待
  { re: /\(y\/n\)|\[y\/N\]|\[Y\/n\]/, label: "交互式确认（等待 stdin 输入）" },
  { re: /Press any key to continue/i, label: "交互式等待（等待 stdin 输入）" },
];

/** 在文本里识别常驻/等待输入特征，返回首个命中的标签；未命中返回 null。 */
export function detectNonTerminatingSignal(text: string): string | null {
  for (const { re, label } of NON_TERMINATING_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

/** 只认绝对路径与 `~/`：相对路径依赖命令内部 cd 之后的 cwd，按 spawn cwd 解析可能读错文件。 */
function resolveReadableTarget(target: string): string | null {
  if (target.startsWith("~/")) return homedir() + target.slice(1);
  if (target.startsWith("/")) {
    // /dev/stdout、/dev/tty、/proc 之类不是普通文件，读它们可能阻塞或无意义。
    if (target.startsWith("/dev/") || target.startsWith("/proc/")) return null;
    return target;
  }
  return null;
}

/** 读文件尾部；非普通文件、不存在、无权限一律静默返回 null（诊断失败不能影响工具返回）。 */
function readTail(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const st = fstatSync(fd);
    if (!st.isFile() || st.size === 0) return null;
    const len = Math.min(TAIL_BYTES, st.size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, st.size - len);
    return buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 回读命令里写入类重定向目标的尾部。返回 [{path, tail}]，最多 MAX_TAIL_FILES 个。 */
export function readRedirectTails(command: string): Array<{ path: string; tail: string }> {
  let targets: string[];
  try {
    targets = extractRedirectTargets(parseBashCommand(command));
  } catch {
    return [];
  }
  const out: Array<{ path: string; tail: string }> = [];
  const seen = new Set<string>();
  for (const t of targets) {
    if (out.length >= MAX_TAIL_FILES) break;
    const p = resolveReadableTarget(t);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    const tail = readTail(p);
    if (tail) out.push({ path: t, tail });
  }
  return out;
}

/**
 * 生成超时提示中「下一步怎么做」与「重定向文件尾部」两段。
 *
 * @param command 原始命令（用于提取重定向目标）
 * @param visibleOutput 管道里拿到的输出（已截断；为空时为 "(命令无输出)"）
 * @param outputEmpty 管道输出是否为空——只有为空时才回读文件，避免重复/冗余
 */
export function buildTimeoutGuidance(
  command: string,
  visibleOutput: string,
  outputEmpty: boolean,
): { guidance: string; redirectSection: string } {
  const tails = outputEmpty ? readRedirectTails(command) : [];
  const redirectSection = tails
    .map(({ path, tail }) => `\n重定向文件 ${path} 的末尾（最多 ${TAIL_BYTES} 字节）:\n${tail}`)
    .join("");

  const signal = detectNonTerminatingSignal(
    [visibleOutput, ...tails.map((t) => t.tail)].join("\n"),
  );
  if (signal) {
    return {
      guidance:
        `输出显示命令进入了「${signal}」，它不会自己退出——转后台（run_in_background）同样会一直挂住。\n` +
        `请改成一次性运行的形式再执行（例如 vitest 用 \`vitest run\`、jest 加 \`--watchAll=false\`、` +
        `交互确认加 \`--yes\`/\`-y\`），或先查看 package.json 等脚本定义确认它是否 watch。`,
      redirectSection,
    };
  }
  return {
    guidance:
      `先判断命令是否会自己退出：watch 模式（如裸 \`vitest\`、\`tsc -w\`）、开发服务器、等待 stdin 输入的命令` +
      `不会结束，应改成一次性运行的形式，转后台无效。\n` +
      `确认只是耗时长时，再用 run_in_background=true 重试。`,
    redirectSection,
  };
}
