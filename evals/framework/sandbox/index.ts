/**
 * Sandbox executor — 隔离执行 agent 输出的代码（T-20 §6.5）
 *
 * 设计依据：docs/eval/investigations/eval-rubric-industry-survey.md §6.5 T-20
 * 业界对齐：
 *   - Inspect AI k8s_sandbox（pod per sample）
 *   - SWE-bench docker container per case
 *   - Inspect Cybench guide（CTF execution）
 *
 * 用途（T-19 execution grading 依赖）：
 *   - code-review case：跑修复后的代码 + 预设单元测试 = pass/fail
 *   - ci-self-heal case：fixture broken code + agent fix → 跑测试验证
 *   - security-audit case：fixture 漏洞 + 命中漏洞列表（binary recall）
 *
 * 当前实现：短期方案
 *   - bun spawn 在 tmpdir 跑命令；超时 + cleanup 兜底
 *   - 限制：无内核级隔离，恶意 agent 输出仍可访问宿主文件系统/网络
 *   - 适用：可信 agent 输出 + 内部 fixture（不接受公开 PR 跑 sandbox）
 *
 * 长期方案（待 S3+ 实施）：docker-in-docker 或 firecracker
 *   - 触发条件：开放公开 PR / 接 SWE-bench / 接外部 contributor
 *   - 工时估计：10 人日（含 sandbox 安全审计）
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";

export interface SandboxOptions {
  /** 工作目录前缀（默认 'sid-sandbox-'） */
  prefix?: string;
  /** 总耗时上限（毫秒，默认 60s） */
  timeoutMs?: number;
  /** 退出后是否保留临时目录（debug 用，默认 false） */
  keepTmp?: boolean;
}

export interface SandboxFile {
  /** 相对路径（如 "src/foo.ts"） */
  path: string;
  content: string;
}

export interface ExecCommand {
  /** 可执行命令（如 "bun"） */
  cmd: string;
  /** 参数（如 ["test", "src/foo.test.ts"]） */
  args: string[];
}

export interface ExecResult {
  cmd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** true = 被 sandbox timeout 强杀 */
  timedOut: boolean;
}

export interface SandboxRunResult {
  /** sandbox 工作目录（保留时可访问；否则已 cleanup） */
  workdir: string;
  /** 所有命令的结果（按执行顺序） */
  exec: ExecResult[];
  /** sandbox 是否全部命令 0 退出 */
  allOk: boolean;
  /** 是否清理过临时目录 */
  cleaned: boolean;
}

/**
 * 创建一次性 sandbox，写入文件后顺序执行命令，最后清理临时目录。
 *
 * @example
 * const r = await runSandbox({
 *   files: [{ path: "test.ts", content: "console.log('hi')" }],
 *   commands: [{ cmd: "bun", args: ["test.ts"] }],
 * });
 * console.log(r.exec[0].stdout); // "hi\n"
 */
export async function runSandbox(opts: {
  files: SandboxFile[];
  commands: ExecCommand[];
  sandbox?: SandboxOptions;
}): Promise<SandboxRunResult> {
  const { files, commands } = opts;
  const so = opts.sandbox ?? {};
  const prefix = so.prefix ?? "sid-sandbox-";
  const timeoutMs = so.timeoutMs ?? 60_000;
  const keepTmp = so.keepTmp ?? false;

  const workdir = mkdtempSync(join(tmpdir(), prefix));

  let exec: ExecResult[] = [];
  try {
    for (const f of files) {
      const abs = resolve(workdir, f.path);
      if (!abs.startsWith(workdir)) {
        throw new Error(`sandbox 拒绝写入越界路径: ${f.path}`);
      }
      const dir = dirname(abs);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(abs, f.content, "utf-8");
    }

    const startAll = Date.now();
    for (const c of commands) {
      const remaining = Math.max(1000, timeoutMs - (Date.now() - startAll));
      const r = await execOne(c.cmd, c.args, workdir, remaining);
      exec.push(r);
      if (r.timedOut) break;
    }
  } finally {
    if (!keepTmp) {
      try {
        rmSync(workdir, { recursive: true, force: true });
      } catch {
        // cleanup 失败不阻断主流程
      }
    }
  }

  const allOk = exec.length > 0 && exec.every((e) => e.exitCode === 0 && !e.timedOut);
  return { workdir, exec, allOk, cleaned: !keepTmp };
}

function execOne(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((res) => {
    const start = Date.now();
    let proc: ChildProcess;
    try {
      proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      res({
        cmd: `${cmd} ${args.join(" ")}`,
        exitCode: -1,
        stdout: "",
        stderr: (e as Error).message,
        durationMs: Date.now() - start,
        timedOut: false,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs);
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
      if (stdout.length > 64 * 1024) stdout = stdout.slice(-64 * 1024); // 防 OOM
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      res({
        cmd: `${cmd} ${args.join(" ")}`,
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      res({
        cmd: `${cmd} ${args.join(" ")}`,
        exitCode: -1,
        stdout,
        stderr: stderr + "\n" + err.message,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

/**
 * 读取 sandbox 跑完后的文件内容（用于 grader 检查生成的 patch 内容等）
 * 必须在 keepTmp=true 时使用，否则文件已被清理
 */
export function readSandboxFile(workdir: string, relPath: string): string {
  const abs = resolve(workdir, relPath);
  if (!abs.startsWith(workdir)) throw new Error(`拒绝读取越界路径: ${relPath}`);
  return readFileSync(abs, "utf-8");
}
