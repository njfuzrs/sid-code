/**
 * bash 工具：后台 daemon 持有输出管道导致工具调用永久挂住的回归测试。
 *
 * 缺陷来源：docs-research 20261031 排查报告（评测 T7 里 2 个 trial 的 bash 调用挂约 2 小时，
 * 手动 kill 才结束；PR #496 本地最小复现：设 3s 超时，22.9s 才返回）。
 *
 * 根因：旧实现先 `await Promise.all([pump(stdout), pump(stderr)])` 再 `await proc.exited`。
 * 管道 EOF 要求**所有**持有写端的进程都关闭它；setsid 脱离进程组的 daemon（nohup /
 * setsid / `xxx --daemon` 且未重定向 stdio）既不在 `kill(-pgid)` 的射程内，又继续持有
 * 写端，于是 pump 的 `for(;;) reader.read()` 永远等不到 done，工具调用永不返回。
 * 超时也救不了：kill 打空之后 timedOut 已为 true，再杀一次仍是空转。
 *
 * 四个场景（编号沿用排查报告 1.3 节）：
 *   A 同进程组后台任务 —— 不变性对照：kill(-pgid) 能杀到，行为必须不变（不出截断说明）
 *   B setsid daemon + 前台长命令 —— 超时分支：kill 之后不再无限等 EOF
 *   C setsid daemon，shell 立即退出 —— **关键场景**：与超时无关（命令本身几毫秒就结束），
 *      旧实现在这里是无条件永久挂住，所以「只改超时分支」的修法修不全
 *   D 同 B 但 daemon 重定向了 stdio —— 不变性对照：本来就没问题，必须不出截断说明
 *
 * 变异自证：把 bash.ts 里宽限期的 `reader.cancel()` 去掉，B/C 两条必须变红。
 */

import { describe, it, expect, beforeAll, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BashTool } from "../../src/tool/bash.ts";

/**
 * setsid daemon 的存活时长。要长到足以暴露「旧实现挂到它退出」的差异（旧代码 B 场景
 * 约 6s、C 场景约 6s 才返回），又短到不会把变异自证拖成几十秒。
 */
const DAEMON_LIFETIME_S = 6;

/** 超时预算：设 3s 超时，旧实现在 B 场景要挂到 daemon 退出（6s）。 */
const TIMEOUT_MS = 3000;

/**
 * 判定「已修好」的墙钟上限。新实现 = 超时 3s + 400ms 管道宽限期 + shell 启动/调度余量；
 * 旧实现的 6s 落在这个上限之外，所以这条断言本身就能区分修复前后，不依赖输出文案。
 */
const TIMEOUT_SCENARIO_BUDGET_MS = 5000;

/**
 * C 场景（无超时压力）的墙钟上限：新实现 ≈ 400ms 宽限期 + shell 启动；
 * 旧实现要等 daemon 的 6s。给足 CI 慢机器的余量。
 */
const FAST_EXIT_SCENARIO_BUDGET_MS = 3000;

/** 截断说明的关键短语（与 bash.ts 的 PIPE_TRUNCATED_NOTICE 对齐，断言短语而非全文以免陷入文案细节）。 */
const TRUNCATION_MARKER = "脱离进程组的后台进程";

/** daemon 需要 `perl` 的 POSIX::setsid（macOS 无 setsid 二进制，perl 两平台都预装）。 */
const PERL_AVAILABLE = (() => {
  try {
    return Bun.spawnSync(["perl", "-e", "exit 0"]).exitCode === 0;
  } catch {
    return false;
  }
})();

const describePosix = process.platform === "win32" ? describe.skip : describe;

/** 每个 daemon 的 pid 落盘位置，afterEach 据此清理，避免测试留下孤儿 sleep。 */
let daemonDir: string | null = null;
let daemonPidFiles: string[] = [];

function newPidFile(): string {
  if (!daemonDir) daemonDir = mkdtempSync(join(tmpdir(), "bash-daemon-pipe-eof-"));
  const file = join(daemonDir, `daemon-${daemonPidFiles.length}.pid`);
  daemonPidFiles.push(file);
  return file;
}

/**
 * 构造「setsid 脱离 shell 进程组、并继承 stdout/stderr」的 daemon 命令片段。
 * redirect=true 用来做 D 场景对照：daemon 自己把 stdio 重定向走，管道正常 EOF。
 */
function setsidDaemon(redirect: boolean): string {
  const redirectPart = redirect ? " >/dev/null 2>&1" : "";
  return `perl -e 'use POSIX; setsid(); exec "sleep","${DAEMON_LIFETIME_S}"'${redirectPart}`;
}

afterEach(() => {
  for (const file of daemonPidFiles) {
    try {
      const pid = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
    } catch {
      /* 文件不存在（命令没跑到写 pid）或进程已退出（ESRCH） */
    }
  }
  daemonPidFiles = [];
  if (daemonDir) {
    rmSync(daemonDir, { recursive: true, force: true });
    daemonDir = null;
  }
});

describePosix("bash 后台 daemon 持管道：超时/收尾不再永久挂住", () => {
  beforeAll(async () => {
    // 首个 BashTool 实例要构建 shell 环境快照（spawn 登录 shell 抓 aliases/functions/options，
    // 本机实测约 2s，A 场景未预热时墙钟因此从 3.4s 涨到 5.3s）。不预热的话这笔一次性开销会
    // 落在第一个用例的墙钟断言上，把它误判成「被 daemon 拖住」——断言测到的就不是被测行为了。
    await new BashTool().execute({ command: "echo warmup", description: "预热 shell 环境快照" });
  });

  it("A 不变性对照：同进程组后台任务被 kill(-pgid) 连带清理，行为不变", async () => {
    const bash = new BashTool();
    const startedAt = Date.now();
    const result = await bash.execute({
      command: `sleep ${DAEMON_LIFETIME_S} & sleep 60`,
      description: "同进程组后台任务 + 前台长命令",
      timeout: TIMEOUT_MS,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.isError).toBe(true);
    expect(result.output).toContain("超时");
    // 同进程组的后台进程会被一起杀掉，管道正常 EOF —— 不该误报截断
    expect(result.output).not.toContain(TRUNCATION_MARKER);
    expect(elapsed).toBeLessThan(TIMEOUT_SCENARIO_BUDGET_MS);
  }, 20000);

  it.skipIf(!PERL_AVAILABLE)(
    "B setsid daemon + 前台长命令：超时后不再等 daemon 关闭写端",
    async () => {
      const bash = new BashTool();
      const pidFile = newPidFile();
      const startedAt = Date.now();
      const result = await bash.execute({
        command: `${setsidDaemon(false)} & echo $! > ${pidFile}; sleep 60`,
        description: "setsid daemon 未重定向输出 + 前台长命令",
        timeout: TIMEOUT_MS,
      });
      const elapsed = Date.now() - startedAt;

      expect(result.isError).toBe(true);
      expect(result.output).toContain("超时");
      // daemon 逃出了进程组，kill 打不到 → 走宽限期截断，结果里要有说明
      expect(result.output).toContain(TRUNCATION_MARKER);
      // 关键断言：必须在 daemon 退出（6s）之前返回
      expect(elapsed).toBeLessThan(TIMEOUT_SCENARIO_BUDGET_MS);
    },
    20000,
  );

  it.skipIf(!PERL_AVAILABLE)(
    "C setsid daemon、shell 立即退出：与超时无关也必须返回（旧实现在此无条件挂住）",
    async () => {
      const bash = new BashTool();
      const pidFile = newPidFile();
      const startedAt = Date.now();
      const result = await bash.execute({
        // 命令本身几毫秒就结束，超时（3s）根本不会触发 —— 这正是「只改超时分支」修不全的原因
        command: `${setsidDaemon(false)} & echo $! > ${pidFile}`,
        description: "只在后台起一个 setsid daemon，命令立即结束",
        timeout: TIMEOUT_MS,
      });
      const elapsed = Date.now() - startedAt;

      // 命令本身成功（exit 0），不该被误标成错误
      expect(result.isError).toBeFalsy();
      expect(result.output).toContain(TRUNCATION_MARKER);
      // 旧实现要等 daemon 的 6s，这条断言直接把它拦下
      expect(elapsed).toBeLessThan(FAST_EXIT_SCENARIO_BUDGET_MS);
    },
    20000,
  );

  it.skipIf(!PERL_AVAILABLE)(
    "D 不变性对照：daemon 自己重定向 stdio 时管道正常 EOF，不出截断说明",
    async () => {
      const bash = new BashTool();
      const pidFile = newPidFile();
      const startedAt = Date.now();
      const result = await bash.execute({
        command: `${setsidDaemon(true)} & echo $! > ${pidFile}; sleep 60`,
        description: "setsid daemon 已重定向输出 + 前台长命令",
        timeout: TIMEOUT_MS,
      });
      const elapsed = Date.now() - startedAt;

      expect(result.isError).toBe(true);
      expect(result.output).toContain("超时");
      // 两个写端都关掉了，管道 EOF 正常到来 —— 不该误报截断
      expect(result.output).not.toContain(TRUNCATION_MARKER);
      expect(elapsed).toBeLessThan(TIMEOUT_SCENARIO_BUDGET_MS);
    },
    20000,
  );
});
