/**
 * G2 运行器：在隔离环境里用真实入口跑一个回放用例，然后断言轨迹与产物。
 *
 * 隔离做法（每条都是踩过或实测过的）：
 * - `env -i` 起子进程，只放白名单变量。宿主的 TERM_PROGRAM / CLAUDE_* / 代理变量都不进来。
 * - `HOME` 指向临时目录，`SID_CONFIG_DIR` 指向另一个临时目录。跑完断言假 HOME 下
 *   **没有** `.sid-code/`：有就说明某个落盘点没跟随 `SID_CONFIG_DIR`（P-3 的长期防线）。
 * - 模型价格写死在 settings.json 里（用户手写价是定价解析的第 2 优先级），
 *   CI 上没有网关价格缓存也算出同一个数，A7 预算熔断才是确定性的。
 * - 不看退出码，除非用例显式声明：无头下命令失败曾一律退 0（无头斜杠命令方案 D2）。
 */
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkEventExpect, checkFileExpect, parseEvents, parseRawRequests } from "./assert.ts";
import { findOutOfRootPaths, substituteCaseRoot } from "./fixture.ts";
import type { DaemonStep, RunOutput, SmokeCase } from "./types.ts";

export const REPO_ROOT = resolve(import.meta.dir, "../../..");
export const CASES_DIR = resolve(import.meta.dir, "../cases");
const SOURCE_ENTRY = join(REPO_ROOT, "packages/cli/src/entrypoints/bootstrap.ts");

export const SMOKE_MODEL = "smoke-replay";
const CASE_TIMEOUT_MS = 60_000;

/** 怎么启动 sid-code：构建产物（默认，测的是「装好的东西」）或源码入口（变异复跑用，免去每次 make build）。 */
export type Launcher = { kind: "binary"; path: string } | { kind: "source" };

export interface CaseResult {
  id: string;
  status: "pass" | "fail" | "skip";
  reason?: string;
  failures: string[];
  durationMs: number;
  /** 失败时保留的工作目录，方便直接翻轨迹 */
  workDir?: string;
}

export interface LoadedCase {
  def: SmokeCase;
  dir: string;
  replayPath: string;
}

export async function loadCases(filter?: string[]): Promise<LoadedCase[]> {
  const ids = readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const out: LoadedCase[] = [];
  for (const id of ids) {
    if (filter && filter.length > 0 && !filter.includes(id)) continue;
    const dir = join(CASES_DIR, id);
    const mod = await import(join(dir, "case.ts"));
    const def: SmokeCase = mod.default;
    if (def.id !== id) throw new Error(`用例目录 ${id} 的 case.ts 声明 id=${def.id}，两者必须一致`);
    out.push({ def, dir, replayPath: join(dir, "replay.jsonl") });
  }
  return out;
}

function launcherArgv(l: Launcher): string[] {
  return l.kind === "binary" ? [l.path] : [process.execPath, SOURCE_ENTRY];
}

/** 子进程只拿到这些变量。PATH 保留 bun 与系统目录，hook 命令和 git 需要它。 */
function isolatedEnv(
  home: string,
  configDir: string,
  replayFile: string,
  extra?: Record<string, string>,
) {
  const bunDir = dirname(process.execPath);
  return {
    PATH: `${bunDir}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: tmpdir(),
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    SID_CONFIG_DIR: configDir,
    SID_CODE_REPLAY_FILE: replayFile,
    SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    SID_CODE_DISABLE_TELEMETRY: "1",
    // 后台记忆提取在 end_turn 后起跑，退出前 drainPending(5_000) 会等满 5s
    // （2026-11-07 实测：同一夹具开着 5.3s、关掉 0.27s）。它不是 G2 要测的东西；
    // 将来要守护记忆提取，单独写用例并在该用例的 env 里打开。
    SID_CODE_AUTO_MEMORY: "0",
    ...extra,
  };
}

/**
 * 预置维护水位线，让所有维护任务判为「未到期」，启动时就不会拉起 detached 维护子进程。
 *
 * 不预置的后果（2026-11-07 实测）：子进程 `unref` 后比主进程活得久，A7 这种 0.4s 就退出的
 * 用例，运行器删完临时目录之后它又把 state/maintenance-*.json 写回来，留下孤儿目录。
 * 维护任务本身不是 G2 要测的东西，所以在源头不让它起，而不是等它跑完。
 */
function seedMaintenanceWatermarks(configDir: string) {
  const now = Date.now();
  const stateDir = join(configDir, "state");
  mkdirSync(stateDir, { recursive: true });
  const tasks = Object.fromEntries(
    ["session-cleanup", "trace-prune", "trace-upload", "worktree-gc", "housekeeping"].map((t) => [
      t,
      now,
    ]),
  );
  writeFileSync(join(stateDir, "maintenance-watermarks.json"), JSON.stringify({ tasks }));
  writeFileSync(join(configDir, ".last-cleanup"), String(now));
}

/**
 * 拿一个确定没人监听的本地端口：让系统分配一个空闲端口，记下后立即关闭。
 *
 * 不写死 9 之类的端口：CI 机器上它不一定是「拒绝连接」（可能被丢包，变成超时重试）。
 * 关闭到子进程连接之间有极短的竞态窗口，被别的进程抢占的概率可以忽略；
 * 真被抢了，用例会因为没触发降级而红，不会静默通过。
 */
function refusedBaseURL(): string {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return `http://127.0.0.1:${port}/v1`;
}

function smokeSettings() {
  return {
    model: SMOKE_MODEL,
    availableModels: [
      {
        name: SMOKE_MODEL,
        provider: "replay",
        apiKey: "smoke-not-a-key",
        pricing: { input: 1, output: 1 },
      },
    ],
  };
}

const DAEMON_STOP_GRACE_MS = 5_000;

/** JSC 的 RegExp.source 会把中文转成 \\uXXXX，失败信息里还原成原文 */
function readableSource(re: RegExp): string {
  return re.source.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** 返回 null 表示步骤本身正常结束（判据交给断言），否则返回失败描述 */
async function runDaemonStep(
  step: DaemonStep,
  caseDir: string,
  launcher: Launcher,
  dirs: { repo: string; home: string; configDir: string; root: string },
): Promise<string | null> {
  const fixture = substituteCaseRoot(readFileSync(join(caseDir, step.replay), "utf8"), dirs.repo);
  const outOfRoot = findOutOfRootPaths(fixture, dirs.repo);
  if (outOfRoot.length > 0) {
    return ["daemon 步骤夹具含用例根目录之外的路径，拒绝执行：", ...outOfRoot].join("\n");
  }
  const replayFile = join(dirs.root, `daemon-${step.replay}`);
  writeFileSync(replayFile, fixture);
  step.prepare?.({ repoRoot: dirs.repo, configDir: dirs.configDir });

  const logPath = join(dirs.configDir, "logs/daemon.log");
  const proc = Bun.spawn(
    [...launcherArgv(launcher), "daemon", "start", "--interval", String(step.intervalMs)],
    {
      cwd: dirs.repo,
      // job 子进程继承 daemon 的 env，所以 SID_CODE_REPLAY_FILE 指向的是 job 的夹具
      env: isolatedEnv(dirs.home, dirs.configDir, replayFile),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdoutP = new Response(proc.stdout).text();
  const stderrP = new Response(proc.stderr).text();
  const deadline = Date.now() + step.timeoutMs;
  let hit = false;
  let exitedEarly = false;
  void proc.exited.then(() => (exitedEarly = true));
  while (Date.now() < deadline && !exitedEarly) {
    if (existsSync(logPath) && step.until.test(readFileSync(logPath, "utf8"))) {
      hit = true;
      break;
    }
    await Bun.sleep(100);
  }
  // 必须在发信号之前取：停机后 proc.exited 也会把它置 true，事后读会把「超时被停」误报成「提前退出」
  const diedOnItsOwn = exitedEarly;
  // 无论成败都停：SIGTERM 走优雅停机（释放锁、注销会话），宽限后 SIGKILL
  if (!diedOnItsOwn) proc.kill("SIGTERM");
  const killer = setTimeout(() => proc.kill("SIGKILL"), DAEMON_STOP_GRACE_MS);
  const exitCode = await proc.exited;
  clearTimeout(killer);
  if (hit) return null;
  const [out, err] = await Promise.all([stdoutP, stderrP]);
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "（无 daemon.log）";
  return (
    `daemon 步骤 ${step.timeoutMs}ms 内 daemon.log 未出现 /${readableSource(step.until)}/` +
    `（${diedOnItsOwn ? `daemon 提前退出 exit=${exitCode}` : "超时后已停止"}）\n` +
    `daemon.log 末尾：${log.slice(-800)}\nstdout/stderr 末尾：${(out + err).slice(-500)}`
  );
}

export async function runCase(
  c: LoadedCase,
  launcher: Launcher,
  /** keep：通过也保留工作目录；keepOnFail（缺省 true）：失败时保留供排查。变异复跑里失败是预期结果，传 false */
  opts: { keep?: boolean; keepOnFail?: boolean } = {},
): Promise<CaseResult> {
  const keepOnFail = opts.keepOnFail ?? true;
  const { def } = c;
  const started = performance.now();
  if (def.platforms && !def.platforms.includes(process.platform)) {
    return {
      id: def.id,
      status: "skip",
      reason: `仅在 ${def.platforms.join("/")} 上运行，当前 ${process.platform}`,
      failures: [],
      durationMs: 0,
    };
  }

  // realpath：macOS 的 /var → /private/var，轨迹与工具入参里记的是真实路径
  const root = realpathSync(mkdtempSync(join(tmpdir(), `sid-smoke-${def.id}-`)));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const configDir = join(root, "config");
  const failures: string[] = [];

  try {
    for (const d of [repo, home, configDir]) mkdirSync(d, { recursive: true });
    for (const [rel, content] of Object.entries(def.repo)) {
      const p = join(repo, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    for (const [rel, content] of Object.entries(def.home ?? {})) {
      // 预置到 .sid-code 下会让 P-3 断言误报（或掩盖真泄漏），直接拒绝
      if (rel === ".sid-code" || rel.startsWith(".sid-code/")) {
        throw new Error(`用例 ${def.id} 的 home 不能预置 .sid-code/（P-3 断言的检查对象）`);
      }
      const p = join(home, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    const defaults = smokeSettings();
    const settings = def.settings
      ? def.settings({ defaults, refusedBaseURL: refusedBaseURL(), repoRoot: repo })
      : defaults;
    writeFileSync(join(configDir, "settings.json"), JSON.stringify(settings, null, 2));
    seedMaintenanceWatermarks(configDir);

    const replay = substituteCaseRoot(readFileSync(c.replayPath, "utf8"), repo);
    const outOfRoot = findOutOfRootPaths(replay, repo);
    if (outOfRoot.length > 0) {
      // 拒绝执行：回放里的工具是真跑的，越界路径会读写用例目录之外的文件
      return {
        id: def.id,
        status: "fail",
        failures: ["夹具含用例根目录之外的路径，拒绝执行：", ...outOfRoot],
        durationMs: performance.now() - started,
      };
    }
    const replayFile = join(root, "replay.jsonl");
    writeFileSync(replayFile, replay);

    const proc = Bun.spawn(
      [
        ...launcherArgv(launcher),
        "--dangerously-skip-permissions",
        "--output-format",
        "json",
        ...def.argv,
      ],
      {
        cwd: repo,
        env: isolatedEnv(home, configDir, replayFile, def.env),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => proc.kill("SIGKILL"), CASE_TIMEOUT_MS);
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    let stdout: unknown = null;
    try {
      stdout = JSON.parse(stdoutText);
    } catch {
      failures.push(
        `stdout 不是合法 JSON（exit=${exitCode}）：${stdoutText.slice(0, 300)}\nstderr 末尾：${stderrText.slice(-500)}`,
      );
    }

    for (const step of def.after ?? []) {
      const f = await runDaemonStep(step, c.dir, launcher, { repo, home, configDir, root });
      if (f) failures.push(f);
    }

    const sessionId = (stdout as any)?.session_id;
    const eventsPath = sessionId
      ? join(configDir, "trajectories/sessions", sessionId, "events.jsonl")
      : null;
    if (stdout !== null && (!eventsPath || !existsSync(eventsPath))) {
      failures.push(`找不到本次会话的轨迹（session_id=${sessionId ?? "缺失"}）`);
    }
    const events =
      eventsPath && existsSync(eventsPath) ? parseEvents(readFileSync(eventsPath, "utf8")) : [];

    for (const exp of def.expect.events ?? []) {
      const f = checkEventExpect(events, exp);
      if (f) failures.push(f);
    }
    const readRepoFile = (rel: string) => {
      const p = join(repo, rel);
      return existsSync(p) ? readFileSync(p, "utf8") : null;
    };
    for (const exp of def.expect.files ?? []) {
      const f = checkFileExpect(readRepoFile, exp);
      if (f) failures.push(f);
    }
    if (def.expect.exitCode !== undefined && exitCode !== def.expect.exitCode) {
      failures.push(`退出码期望 ${def.expect.exitCode}，实际 ${exitCode}`);
    }
    if (def.expect.output) {
      const rawPath = sessionId
        ? join(configDir, "trajectories/sessions", sessionId, "raw.jsonl")
        : null;
      const requests =
        rawPath && existsSync(rawPath) ? parseRawRequests(readFileSync(rawPath, "utf8")) : [];
      const out: RunOutput = {
        exitCode,
        stdout,
        stderr: stderrText,
        requests,
        configDir,
        homeDir: home,
      };
      const f = def.expect.output(out);
      if (f) failures.push(f);
    }
    // P-3 长期防线：所有落盘都必须跟随 SID_CONFIG_DIR
    if (existsSync(join(home, ".sid-code"))) {
      const leaked = Bun.spawnSync(["find", join(home, ".sid-code"), "-type", "f"])
        .stdout.toString()
        .trim();
      failures.push(
        `有文件写进了 $HOME/.sid-code（没跟随 SID_CONFIG_DIR）：\n${leaked.split("\n").slice(0, 10).join("\n")}`,
      );
    }

    return {
      id: def.id,
      status: failures.length === 0 ? "pass" : "fail",
      failures,
      durationMs: performance.now() - started,
      workDir: (failures.length > 0 && keepOnFail) || opts.keep ? root : undefined,
    };
  } finally {
    // 只删本次 mkdtemp 出来的目录；失败时按 keepOnFail 决定是否保留供排查
    const keep = opts.keep || (failures.length > 0 && keepOnFail);
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
}

/** 写进 $GITHUB_STEP_SUMMARY 的表格：job 绿的时候 skip 也要看得见。 */
export function renderSummary(results: CaseResult[], title: string): string {
  const icon = { pass: "✅", fail: "❌", skip: "⏭️" } as const;
  const rows = results.map(
    (r) =>
      `| ${r.id} | ${icon[r.status]} ${r.status} | ${(r.durationMs / 1000).toFixed(1)}s | ${(
        r.reason ??
        r.failures[0] ??
        ""
      )
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ")
        .slice(0, 160)} |`,
  );
  return [
    `### ${title}`,
    "",
    "| 用例 | 结果 | 耗时 | 说明 |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
