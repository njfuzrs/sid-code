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
import type {
  DaemonStep,
  PrintStep,
  RunOutput,
  ServiceHit,
  SmokeCase,
  StepOutput,
} from "./types.ts";

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

type StepDirs = { repo: string; home: string; configDir: string; root: string };
type StepResult = { output: StepOutput; failure: string | null };

/** 步骤夹具：占位符替换 + 越界校验，与主夹具同一套规则 */
function prepareStepFixture(
  rel: string,
  caseDir: string,
  dirs: StepDirs,
  kind: StepOutput["kind"],
): { file: string } | { failure: string } {
  const fixture = substituteCaseRoot(readFileSync(join(caseDir, rel), "utf8"), dirs.repo);
  const outOfRoot = findOutOfRootPaths(fixture, dirs.repo);
  if (outOfRoot.length > 0) {
    return {
      failure: [`${kind} 步骤夹具含用例根目录之外的路径，拒绝执行：`, ...outOfRoot].join("\n"),
    };
  }
  const file = join(dirs.root, `${kind}-${rel}`);
  writeFileSync(file, fixture);
  return { file };
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
  dirs: StepDirs,
): Promise<StepResult> {
  const fixture = prepareStepFixture(step.replay, caseDir, dirs, "daemon");
  if ("failure" in fixture)
    return { output: { kind: "daemon", exitCode: -1, stderr: "" }, failure: fixture.failure };
  const replayFile = fixture.file;
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
  const [out, err] = await Promise.all([stdoutP, stderrP]);
  const output: StepOutput = { kind: "daemon", exitCode, stderr: err };
  if (hit) return { output, failure: null };
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "（无 daemon.log）";
  const failure =
    `daemon 步骤 ${step.timeoutMs}ms 内 daemon.log 未出现 /${readableSource(step.until)}/` +
    `（${diedOnItsOwn ? `daemon 提前退出 exit=${exitCode}` : "超时后已停止"}）\n` +
    `daemon.log 末尾：${log.slice(-800)}\nstdout/stderr 末尾：${(out + err).slice(-500)}`;
  return { output, failure };
}

/** 再跑一次 `-p`（同一隔离环境）。进程正常结束即算步骤成功，判据交给断言 */
async function runPrintStep(
  step: PrintStep,
  caseDir: string,
  launcher: Launcher,
  dirs: StepDirs,
  extraEnv?: Record<string, string>,
): Promise<StepResult> {
  const fixture = prepareStepFixture(step.replay, caseDir, dirs, "print");
  if ("failure" in fixture)
    return { output: { kind: "print", exitCode: -1, stderr: "" }, failure: fixture.failure };
  step.prepare?.({ repoRoot: dirs.repo, configDir: dirs.configDir });
  const proc = Bun.spawn(
    [
      ...launcherArgv(launcher),
      "--dangerously-skip-permissions",
      "--output-format",
      "json",
      ...step.argv,
    ],
    {
      cwd: dirs.repo,
      env: isolatedEnv(dirs.home, dirs.configDir, fixture.file, extraEnv),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => proc.kill("SIGKILL"), CASE_TIMEOUT_MS);
  const [, err, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { output: { kind: "print", exitCode, stderr: err }, failure: null };
}

/** stdout 逐行解析；非 JSON 行（如混入的日志）跳过 */
function parseJsonLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 跳过 */
    }
  }
  return out;
}

/**
 * stream-json 多轮：逐条写 user 消息，等到第 i 条 `result` 再写第 i+1 条，最后关 stdin。
 * 进程提前退出时不再等（剩余消息不写），由调用方按 result 条数判失败。返回 stdout 全文。
 */
async function driveStreamInput(
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
  inputs: string[],
): Promise<string> {
  let text = "";
  let results = 0;
  let exited = false;
  // 用对象装回调：闭包里赋值的 `let` 在 TS 控制流分析下会被收窄成 null，调用处报不可调用
  const waiter: { wake: (() => void) | null } = { wake: null };
  const reader = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    const r = proc.stdout.getReader();
    for (;;) {
      const { value: chunk, done } = await r.read();
      if (done) break;
      const piece = dec.decode(chunk, { stream: true });
      text += piece;
      buf += piece;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.includes('"type":"result"')) {
          results++;
          waiter.wake?.();
        }
      }
    }
  })();
  void proc.exited.then(() => {
    exited = true;
    waiter.wake?.();
  });
  for (let i = 0; i < inputs.length; i++) {
    if (exited) break;
    proc.stdin.write(
      JSON.stringify({ type: "user", message: { role: "user", content: inputs[i] } }) + "\n",
    );
    proc.stdin.flush();
    while (results <= i && !exited) {
      await new Promise<void>((r) => (waiter.wake = r));
    }
  }
  if (!exited) proc.stdin.end();
  await reader;
  return text;
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
  const servers: ReturnType<typeof Bun.serve>[] = [];
  const serviceUrls: Record<string, string> = {};
  const serviceHits: Record<string, ServiceHit[]> = {};

  try {
    for (const d of [repo, home, configDir]) mkdirSync(d, { recursive: true });
    for (const [name, svc] of Object.entries(def.services ?? {})) {
      const hits: ServiceHit[] = [];
      serviceHits[name] = hits;
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (req) => {
          hits.push({
            method: req.method,
            path: new URL(req.url).pathname,
            auth: req.headers.has("authorization"),
          });
          return svc.handler(req);
        },
      });
      servers.push(server);
      serviceUrls[name] = `http://127.0.0.1:${server.port}`;
    }
    for (const [rel, content] of Object.entries(def.config ?? {})) {
      if (rel === "settings.json") {
        throw new Error(`用例 ${def.id} 的 config 不能写 settings.json，请用 settings 字段`);
      }
      const p = join(configDir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, { mode: 0o600 });
    }
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
      ? def.settings({
          defaults,
          refusedBaseURL: refusedBaseURL(),
          repoRoot: repo,
          services: serviceUrls,
        })
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

    const stream = def.streamInput !== undefined;
    const proc = Bun.spawn(
      [
        ...launcherArgv(launcher),
        ...(def.realPermissions ? [] : ["--dangerously-skip-permissions"]),
        ...(stream
          ? ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
          : ["--output-format", "json"]),
        ...def.argv,
      ],
      {
        cwd: repo,
        env: isolatedEnv(home, configDir, replayFile, def.env),
        stdin: stream ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => proc.kill("SIGKILL"), CASE_TIMEOUT_MS);
    const stdoutPromise = stream
      ? driveStreamInput(proc, def.streamInput!)
      : new Response(proc.stdout).text();
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      stdoutPromise,
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    let stdout: unknown = null;
    if (stream) {
      const messages = parseJsonLines(stdoutText);
      const results = messages.filter((m) => (m as { type?: unknown }).type === "result");
      if (results.length !== def.streamInput!.length) {
        failures.push(
          `stream-json 输入 ${def.streamInput!.length} 条，result 只有 ${results.length} 条（exit=${exitCode}）\nstderr 末尾：${stderrText.slice(-500)}`,
        );
      }
      // 运行器后续按 stdout.session_id 找轨迹；数组本身交给断言
      stdout = Object.assign(messages, {
        session_id: (results.find((r) => (r as any).session_id) as any)?.session_id,
      });
    } else {
      try {
        stdout = JSON.parse(stdoutText);
      } catch {
        failures.push(
          `stdout 不是合法 JSON（exit=${exitCode}）：${stdoutText.slice(0, 300)}\nstderr 末尾：${stderrText.slice(-500)}`,
        );
      }
    }

    const steps: StepOutput[] = [];
    for (const step of def.after ?? []) {
      const dirs = { repo, home, configDir, root };
      const r =
        step.kind === "daemon"
          ? await runDaemonStep(step, c.dir, launcher, dirs)
          : await runPrintStep(step, c.dir, launcher, dirs, def.env);
      steps.push(r.output);
      if (r.failure) failures.push(r.failure);
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
        steps,
        services: serviceHits,
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
    // 桩服务无论成败都关，先于删目录（服务不读写目录，但别让端口挂到下一个用例）
    for (const server of servers) server.stop(true);
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
