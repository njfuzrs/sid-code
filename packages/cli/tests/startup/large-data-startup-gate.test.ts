/**
 * 大数据启动门禁（G1，PR-A 立、PR-B 起生效）。
 *
 * ## 不变量
 *
 * TUI 进程在首帧前和交互期间，主线程不做任何耗时随 `~/.sid-code/` 数据量增长的工作。
 *
 * ## 判据为什么是「差值」而不是绝对阈值
 *
 * 同一份二进制在**空配置目录**和**大数据配置目录**下各起一次 TUI，比两次的
 * `first_frame` 与 `max_loop_block_before_interactive`。不变量说的就是「与数据量无关」，
 * 差值正好量它；绝对值里混着模块编译、工具注册这类常数项，慢 runner 上会整体抬高，
 * 拿绝对阈值卡会变成 flake（本机空目录已有 ~140ms 的常数阻塞）。绝对值只设一道宽的兜底。
 *
 * 修复前实测（同一套 fixture）：会话清理全量读 + parse 200MB 单行、collector 构造扫几百个
 * 轨迹目录，阻塞是秒级——差值门禁一眼可见。
 *
 * ## 取数源
 *
 * `SID_CODE_PROFILE_STARTUP_DUMP` 落的 JSON（shared/utils/startup-profiler.ts）：
 * 首帧后 3s 窗口结束时写一次，不依赖 TUI 退出路径。
 *
 * ## 平台口径（2026-11-06）：macOS 计时只报告，结构性门禁双平台阻断
 *
 * macOS 共享 runner 的时序噪声与阈值同量级（两次放宽到 300ms 后实测中位数仍有
 * 322~871ms，空目录自身在 601~1346ms 间漂），计时断言的绿/红由 runner 负载决定，
 * 继续调阈值会高过已知真实回归（C1 +698ms）本身。所以 macOS 的四处计时断言降级为
 * `[gate:report-only]`；补回的检出能力是**结构性门禁**：首帧前主进程调用会话清理 /
 * 轨迹扫描 / 补传压缩入口的次数必须为 0（profiler 的 `counters`），它不吃 runner 负载。
 * ubuntu / 本机计时断言仍阻断（那里的噪声只有 ±30ms）。
 * 依据与否决论证见 `.agents/notes/implemented/testing/2026-11-06-启动门禁macOS计时改只报告加结构性门禁.md`。
 *
 * ## 补传（U1–U4，PR-C 起生效）
 *
 * 另起一个配了上传地址的目录：一个 ≥200MB、无 `.uploaded` 的 traj 会话，上传地址指向本进程里
 * 一个只挂住不响应的 server。修复前补传在 TUI 进程里 gzipSync 整份 traj（3s 级阻塞），
 * 修复后整条补传在维护子进程里跑，同样按「与空目录的差值」断言。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";

const BOOTSTRAP = join(import.meta.dir, "..", "..", "src", "entrypoints", "bootstrap.ts");
/** 巨型会话 jsonl 的体积（复现 10-22 那份 222MB 会话的形态：一条 user_message 单行巨大） */
const BIG_SESSION_BYTES = 200 * 1024 * 1024;
/** 轨迹目录数（本机 579 个） */
const TRACE_DIRS = 1500;
/** 每个轨迹目录 tool-outputs 下的文件数（dirBytes 递归 stat 的规模） */
const TRACE_FILES_PER_DIR = 20;
/** 会话文件数（本机 768 个） */
const SESSION_FILES = 300;

interface Profile {
  checkpoints: Array<{ name: string; ms: number }>;
  metrics: Record<string, number>;
  /** 首帧前维护任务入口的调用次数（profiler 的 `profileCounter`），结构性门禁的取数源 */
  counters?: Record<string, number>;
}

const homes: string[] = [];

function makeHome(extra: Record<string, unknown> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "sid-startup-gate-"));
  homes.push(home);
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({
      ...extra,
      model: "m",
      availableModels: [
        { name: "m", provider: "openai", api_key: "sk-test", base_url: "http://127.0.0.1:9/v1" },
      ],
      // debugLogFile 默认是字面量 ~/.sid-code/debug.log，不走 SID_CONFIG_DIR，显式改指隔离目录
      debug_log_file: join(home, "debug.log"),
    }),
  );
  return home;
}

/**
 * fixture 的时间口径：**会被扫描、但不会被删**。
 * 30 天前 = 过了 minRetention(1d)、没到 maxAge(365d)。门禁要跑多次启动取中位数，
 * 第一版用 400 天前的数据，第一轮启动（或变异版的主线程清理）就把巨型会话删了，
 * 后几轮量的是空目录——C1 放回主线程的变异因此没能让门禁变红。
 */
const SCANNED = new Date(Date.now() - 30 * 24 * 3600_000);
/** 只给「确实过期、该被子进程删掉」的那一个探针会话用 */
const EXPIRED = new Date(Date.UTC(2024, 0, 1));

/** 流式写一个巨型会话 jsonl：session_start + 一条 BIG 字节的 user_message（不在内存里拼巨串） */
function writeBigSession(dir: string, id: string): string {
  const file = join(dir, `${id}.jsonl`);
  const fd = openSync(file, "w");
  const t = SCANNED.toISOString();
  writeSync(
    fd,
    JSON.stringify({
      type: "session_start",
      sessionId: id,
      model: "m",
      provider: "p",
      cwd: "/",
      timestamp: t,
    }) + "\n",
  );
  writeSync(fd, '{"type":"user_message","message":{"role":"user","content":"');
  // 正文取「二进制被内联进消息」的真实形态：大量 \uXXXX / \n / \" 转义。
  // 纯 "aaaa" 的 JSON.parse 快一个量级，第一版 fixture 用它，C1 放回主线程的变异只多阻塞 58ms，没能变红。
  const unit = '\\u0000\\u0001ELF\\n\\t\\"\\\\\\u00ff\\ufffd';
  const chunk = Buffer.from(unit.repeat(Math.ceil((8 * 1024 * 1024) / unit.length)));
  for (let n = 0; n < BIG_SESSION_BYTES; n += chunk.length) writeSync(fd, chunk);
  writeSync(fd, `"},"timestamp":"${t}"}\n`);
  closeSync(fd);
  utimesSync(file, SCANNED, SCANNED);
  return file;
}

function writeSmallSession(dir: string, id: string, when: Date): string {
  const f = join(dir, `${id}.jsonl`);
  const t = when.toISOString();
  writeFileSync(
    f,
    [
      { type: "session_start", sessionId: id, model: "m", provider: "p", cwd: "/", timestamp: t },
      { type: "user_message", message: { role: "user", content: "hi" }, timestamp: t },
      { type: "assistant_message", message: { role: "assistant", content: "yo" }, timestamp: t },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  utimesSync(f, when, when);
  return f;
}

function populateLargeHome(home: string): { bigSession: string; expiredProbe: string } {
  const projDir = join(home, "sessions", "proj");
  mkdirSync(projDir, { recursive: true });
  for (let i = 0; i < SESSION_FILES; i++) {
    writeSmallSession(projDir, `20261001-000000-${String(i).padStart(8, "0")}`, SCANNED);
  }
  const expiredProbe = writeSmallSession(projDir, "20240101-000000-expired0", EXPIRED);
  const bigSession = writeBigSession(projDir, "20261001-000000-bigbigbi");

  // 轨迹目录取真实形态：有数据（不会被当空壳删）、带终态上传标记、tool-outputs 下一堆小文件。
  // T1 的成本在 hasFinalUploadMarker 的 readFileSync + dirBytes 递归 stat，只放一个小文件的
  // 空壳目录测不出它（第一版 fixture 就是这样，T1 放回构造函数的变异没能让门禁变红）。
  // mtime 取「现在」：在 minRetention 窗口内，淘汰不会删它们，每次启动都要扫一遍。
  const traceRoot = join(home, "trajectories", "sessions");
  for (let i = 0; i < TRACE_DIRS; i++) {
    const d = join(traceRoot, `20240101-000000-t${String(i).padStart(7, "0")}`);
    const outputs = join(d, "tool-outputs");
    mkdirSync(outputs, { recursive: true });
    writeFileSync(join(d, "events.jsonl"), JSON.stringify({ event: "AfterModelRaw" }) + "\n");
    writeFileSync(join(d, "session.traj"), "{}");
    writeFileSync(join(d, ".uploaded"), JSON.stringify({ final: true }));
    for (let k = 0; k < TRACE_FILES_PER_DIR; k++) writeFileSync(join(outputs, `o${k}.txt`), "x");
  }
  return { bigSession, expiredProbe };
}

/** traj 体积：复现 10-22 那份 445MB traj 的形态（同样大量转义） */
const BIG_TRAJ_BYTES = 200 * 1024 * 1024;

/** 一个待补传的巨型轨迹会话：traj ≥200MB、events 在、无 .uploaded、目录静置够久 */
function populateUploadHome(home: string): string {
  const id = "20261001-000000-upupupup";
  const d = join(home, "trajectories", "sessions", id);
  mkdirSync(d, { recursive: true });
  const traj = join(d, "session.traj");
  const fd = openSync(traj, "w");
  writeSync(fd, '{"metadata":{"session_id":"' + id + '","total_cost_usd":1},"history":["');
  const unit = '\\u0000\\u0001ELF\\n\\t\\"\\\\\\u00ff\\ufffd';
  const chunk = Buffer.from(unit.repeat(Math.ceil((8 * 1024 * 1024) / unit.length)));
  for (let n = 0; n < BIG_TRAJ_BYTES; n += chunk.length) writeSync(fd, chunk);
  writeSync(fd, '"]}');
  closeSync(fd);
  // 必须带 AfterModelRaw：没有可重算事件时 backfillTrajCost 提前返回、根本不读 traj，
  // U2（整份 parse 200MB traj，真实数据上最大的阻塞源）就没被覆盖——第一版就是这样空转的。
  writeFileSync(
    join(d, "events.jsonl"),
    [
      { event: "SessionStart", timestamp: SCANNED.toISOString() },
      {
        event: "AfterModelRaw",
        timestamp: SCANNED.toISOString(),
        data: { index: 1, model: "m", usage: { input_tokens: 1000, output_tokens: 100 } },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  utimesSync(traj, SCANNED, SCANNED);
  utimesSync(d, SCANNED, SCANNED);
  return d;
}

/**
 * 宽限期：这一段时间内「结果文件和锁都不出现」就认为本目录这轮压根没起子进程。
 *
 * 没有它会死等满 90s——大数据目录只有第一轮会把三项任务跑完并写水位线，之后每一轮
 * `dueMaintenanceTasks` 都返回空，`launchMaintenance` 直接返回 false，一个子进程都不会起。
 * 子进程真起来时（第一轮）会在几秒内建好锁，宽限期不会被用满。
 */
const MAINT_CHILD_GRACE_MS = 15_000;

/**
 * 等本目录的后台维护子进程彻底退出。
 *
 * 它 detached + unref（`maintenance/launcher.ts`），TUI 进程退出后仍在跑：扫 300 个会话、
 * 读 200MB 巨型会话、扫 1500 个轨迹目录。不等它就进下一次启动，子进程会和这次启动抢 CPU，
 * 把首帧抬高——macOS runner 上实测 +200ms 级假阳性（本文档第一节那些 38.8~293.6ms 的跳变）。
 *
 * 完成信号用 `state/maintenance-result.json`：子进程跑完在 finally 里写它再释放锁
 * （`maintenance/runner.ts`）；锁还在 = 进程还没真正退出，两个都等到才算「彻底结束」。
 *
 * ⚠️ 不要改回「固定 sleep 后判一次锁存在性」。那个写法在慢 runner 上有竞态：
 * 子进程（bun 启动 + 模块加载）还没建锁时这里立刻返回，下一轮启动于是与上一轮的
 * 200MB 压缩重叠。macOS CI 实测该形态 Δframe = 224.6ms / 351.2ms（阈值 150ms），
 * main 与 PR #561 各撞一次；同一份代码本机只有 28.6ms。
 *
 * ⚠️ 另一头也要防：调用点可能落在一个「这轮没有子进程」的目录上（见
 * {@link MAINT_CHILD_GRACE_MS}）。死等 90s 会把 beforeAll 拖垮，所以宽限期过后两者
 * 都不存在就直接返回；一旦锁出现过，说明子进程确实在跑，就一路等到结果落盘。
 */
async function waitMaintenanceIdle(home: string): Promise<void> {
  const result = join(home, "state", "maintenance-result.json");
  const lock = join(home, "state", "maintenance.lock");
  const t0 = performance.now();
  const deadline = t0 + 90_000;
  // 1. 等本轮的维护结果落盘（补传目录的那份在 resetUploadState 里每轮先删掉）
  while (!existsSync(result)) {
    const now = performance.now();
    if (now >= deadline) break;
    if (now - t0 > MAINT_CHILD_GRACE_MS && !existsSync(lock)) break;
    await Bun.sleep(100);
  }
  // 2. 写结果到进程退出之间还有几行（峰值内存、释放锁），等它彻底结束再进下一轮
  while (existsSync(lock) && performance.now() < deadline) await Bun.sleep(100);
}

/** `maintenance-result.json` 的摘要（子进程落盘，见 `maintenance/runner.ts` 的 result 组装） */
interface MaintSummary {
  startedAt: number;
  finishedAt: number;
  tasks: Array<{ name: string; ok: boolean; durationMs: number }>;
}

/** 读一目录的维护结果；还没有（子进程没跑完 / 这轮没起子进程）时返回 undefined */
function readMaintSummary(home: string): MaintSummary | undefined {
  const file = join(home, "state", "maintenance-result.json");
  if (!existsSync(file)) return undefined;
  try {
    const r = JSON.parse(readFileSync(file, "utf-8")) as {
      startedAt?: unknown;
      finishedAt?: unknown;
      tasks?: Record<string, { ok?: boolean; durationMs?: number }>;
    };
    if (typeof r.startedAt !== "number" || typeof r.finishedAt !== "number") return undefined;
    return {
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      tasks: Object.entries(r.tasks ?? {}).map(([name, v]) => ({
        name,
        ok: v?.ok !== false,
        durationMs: typeof v?.durationMs === "number" ? v.durationMs : -1,
      })),
    };
  } catch {
    return undefined;
  }
}

/**
 * 一轮的观测快照。
 *
 * 中位数会掩盖方差：macOS 上首帧差值在 38.8~293.6ms 之间跳，只看中位数没法判断是
 * 「l1 被上一轮的子进程抬高」「l0 冷读慢」还是「每一轮都噪声很大」。这三个假设对应
 * 三种不同的修法，所以时间线和原始值必须先落到日志里。
 */
interface RoundTrace {
  round: number;
  /** 本轮的墙钟窗口（相对 beforeAll 起点，ms），用来和 maintenance-result 的时段对时间 */
  from: number;
  to: number;
  /** 三组各自的单次值（ms） */
  frame: { empty: number; large: number; upload: number };
  block: { empty: number; large: number; upload: number };
  /** 本轮开始时大数据目录的维护子进程是否还在跑（true = 这一轮是在被抢 CPU 的环境里测的） */
  largeBusyAtStart: boolean;
  /** 本轮结束时是否还在跑（true = 它会一路压到下一轮，正是候选根因 A 的形态） */
  largeBusyAtEnd: boolean;
}

/**
 * 把每轮的原始值与维护子进程时间线打进日志。
 *
 * 现有断言只比较中位数，红的时候看不到单轮原始值，也看不到大数据目录那个维护子进程
 * 什么时候跑的，于是「l1 被跨轮子进程抬高」「l0 冷读慢」「整轮都噪声大」三种根因
 * 完全分不开，只能靠重跑去猜。这份输出至少能回答「子进程覆盖了哪几轮」。
 */
function logRoundTraces(
  traces: RoundTrace[],
  largeMaint: MaintSummary | undefined,
  wallStart: number,
): void {
  if (traces.length === 0) return;
  const cell = (v: number) => Math.round(v);
  console.log("[gate] 每轮原始值（frame/block，ms）与大目录维护子进程是否在跑：");
  for (const t of traces) {
    console.log(
      `[gate]   轮${t.round} [${rel(t.from)}..+${Math.round(t.to)}] ` +
        `空 ${cell(t.frame.empty)}/${cell(t.block.empty)} ` +
        `大 ${cell(t.frame.large)}/${cell(t.block.large)} ` +
        `传 ${cell(t.frame.upload)}/${cell(t.block.upload)} | ` +
        `大目录子进程 起=${t.largeBusyAtStart ? "跑" : "闲"} 止=${t.largeBusyAtEnd ? "跑" : "闲"}`,
    );
  }
  // 断言真正吃的口径：同一轮内的配对差值（轮间漂移在减法里消掉，见 pairedDelta 注释）。
  // 原始值只能回答「哪一轮慢」，配对差值才能回答「大数据目录多做了多少活」。
  console.log("[gate] 每轮配对差值（同一轮内 被测−空，frame/block，ms）：");
  for (const t of traces) {
    console.log(
      `[gate]   轮${t.round} 大−空 ${cell(t.frame.large - t.frame.empty)}/${cell(t.block.large - t.block.empty)} ` +
        `传−空 ${cell(t.frame.upload - t.frame.empty)}/${cell(t.block.upload - t.block.empty)}`,
    );
  }
  if (largeMaint) {
    const start = largeMaint.startedAt - wallStart;
    const end = largeMaint.finishedAt - wallStart;
    const tasks = largeMaint.tasks
      .map((x) => `${x.name}=${x.durationMs}ms${x.ok ? "" : "(失败)"}`)
      .join(" ");
    console.log(
      `[gate]   大目录维护子进程时段 [${rel(start)}..${rel(end)}] 共 ${largeMaint.finishedAt - largeMaint.startedAt}ms：${tasks}`,
    );
  } else {
    console.log("[gate]   大目录维护子进程：没读到 maintenance-result.json");
  }
}

/**
 * 每轮带上传的启动前，把上一轮补传留下的记账清掉，让每一轮都真的去做补传。
 *
 * 不清的话只有第一轮干活：之后压缩缓存命中、`.upload-attempts` 在退避里、trace-upload 的
 * 1h 维护水位线未到期，三轮取中位数会把唯一那轮吸收掉（变异自证时发现门禁空转才加的）。
 * 删的都是本测试在自己 tmp 目录里造出来的产物。
 *
 * `maintenance-result.json` 一并删：它是 {@link waitMaintenanceIdle} 的完成信号——
 * 留着上一轮那份，等待会立刻返回，等于没等。
 */
function resetUploadState(home: string, sessionDir: string): void {
  for (const f of [".upload-cache", ".upload-attempts", ".upload-failed", ".cost-recomputed"]) {
    rmSync(join(sessionDir, f), { recursive: true, force: true });
  }
  rmSync(join(sessionDir, ".uploaded"), { force: true });
  rmSync(join(home, "state", "maintenance-watermarks.json"), { force: true });
  rmSync(join(home, "state", "maintenance-result.json"), { force: true });
  utimesSync(sessionDir, SCANNED, SCANNED);
}

/** 在 pty 里起一次 TUI，等剖析 dump 落盘后杀掉 */
async function startOnce(home: string): Promise<Profile> {
  const dump = join(home, `profile-${Date.now()}.json`);
  const term = new Bun.Terminal({ cols: 120, rows: 40, data() {} });
  const proc = Bun.spawn(["bun", BOOTSTRAP], {
    terminal: term,
    cwd: home,
    env: {
      ...process.env,
      SID_CONFIG_DIR: home,
      SID_CODE_DISABLE_PROJECT_RULES: "1",
      SID_CODE_PROFILE_STARTUP: "1",
      SID_CODE_PROFILE_STARTUP_DUMP: dump,
      TERM: "xterm-256color",
    },
  });
  try {
    const deadline = performance.now() + 45_000;
    while (!existsSync(dump) && performance.now() < deadline) await Bun.sleep(100);
    if (!existsSync(dump)) throw new Error("45s 内没拿到启动剖析 dump（TUI 没起来或首帧没出）");
    return JSON.parse(readFileSync(dump, "utf-8")) as Profile;
  } finally {
    proc.kill();
    await proc.exited;
    term.close();
  }
}

/** 每种配置的启动次数（取中位数） */
const RUNS = 3;

/**
 * 计时断言的平台策略：macOS 只报告，ubuntu / 本机阻断。
 *
 * ## 为什么 macOS 降级为只报告（2026-11-06）
 *
 * 两次放宽阈值（首帧 150→300、阻塞 100→300）之后仍然红，而放宽后的实测中位数已经到
 * 322~871ms，与已知真实回归同量级（C1 +698ms、T1/T2 +353ms）：
 *
 * ```text
 * run 41989505947  Δframe 中位数 411.6  空=[642/723/606]     大=[1053/1188/728]
 * run 41989811765  Δframe 中位数 322    空=[1161/965/1346]   大=[1949/1287/1141]
 * run 42004678644  Δframe 中位数 511.3  空=[1128/816/835]    大=[1088/1327/1349]
 * run 42008890919  Δframe 中位数 871    空=[804/601/912]     大=[2134/1472/989]
 * ```
 *
 * 分母（空目录）自己就在 601~1346ms 间漂，3 轮取中位数压不住这个量级的噪声。
 * 再放宽会高过 C1 变异本身，门禁就失去意义了 —— 绿/红由 runner 负载决定，不由代码决定。
 * ubuntu 上噪声只有 ±30ms，150/100ms 阈值信噪比足够，**不降级**。
 *
 * ## 检出能力靠什么补
 *
 * 结构性门禁（下面「首帧前主进程没调用维护任务入口」那条）：首帧前会话清理 / 轨迹扫描 /
 * 补传压缩的入口调用次数必须为 0。它不吃 runner 负载，两个平台都阻断，
 * 覆盖 C1 / T1 / T2 / 补传四类已知回归（变异自证见 Agent Note）。
 *
 * ## 平台分支本身要有一条测试锁住
 *
 * `if (platform !== "darwin") expect(...)` 这种写法把断言包起来却没有对应断言锁分支，
 * 哪天有人把 ubuntu 也改成只报告，所有计时断言照样全绿。见「计时断言按平台分档」。
 */
export function timingAssertionsBlocking(platform: string): boolean {
  return platform !== "darwin";
}

/** 首帧差值阈值（ms）：只在阻断平台上生效 */
const FRAME_DELTA_LIMIT_MS = 150;

/** 事件循环阻塞差值阈值（ms）：只在阻断平台上生效 */
const BLOCK_DELTA_LIMIT_MS = 100;

/** 本次进程是否阻断计时断言（macOS 只报告） */
const TIMING_BLOCKING = timingAssertionsBlocking(process.platform);

/**
 * 计时断言：阻断平台走 expect，macOS 只打一行 `[gate:report-only]`（带逐轮原始值，
 * 人工看趋势要用）。report-only 不是「静默跳过」—— 它必须留下可 grep 的输出。
 */
function assertTiming(label: string, actual: number, limit: number, detail: string): void {
  if (!TIMING_BLOCKING) {
    console.log(
      `[gate:report-only] ${label}：${actual}ms（阈值 ${limit}ms，macOS 不阻断）；${detail}`,
    );
    return;
  }
  expect(actual, `${detail}（中位数 ${actual}ms，阈值 ${limit}ms）`).toBeLessThan(limit);
}

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

type Config = "empty" | "large" | "upload";

/**
 * 每轮的启动顺序：三轮轮转，让三种配置在「先测 / 中测 / 后测」三个位置上各坐一次。
 *
 * ## 为什么不能固定「空 → 大 → 传」
 *
 * 轮内漂移是单向的：后测的那次更容易吃到前面启动留下的缓存与负载。固定顺序等于让
 * 大数据目录永远吃这个亏。2026-11-04 的 macOS 失败里每轮都是「大 > 空」，且后面的轮次
 * 差值更大（137 / 180 / 193ms），与「同一轮内越晚越慢」的形态吻合 —— 而它不是我们要量的东西。
 *
 * 三轮 × 三个位置正好被三种配置各覆盖一次，位置偏差在轮转中被抵消；换成 ABBA 两轮也能
 * 抵消，但 RUNS=3 时轮转比「偶正反交替」少一种边界情况，且加轮次（RUNS=6/9）依然对称。
 */
const ROUND_ORDER: readonly (readonly Config[])[] = [
  ["empty", "large", "upload"],
  ["large", "upload", "empty"],
  ["upload", "empty", "large"],
];

/**
 * 逐轮配对差值：同一轮里「被测配置 − 空目录」。
 *
 * ## 为什么不能拿两组各自的中位数相减
 *
 * 那样两个数来自**不同的轮次**，整机负载的漂移直接进了差值。2026-11-04 的两次 macOS 失败
 * 就是这种形态：PR #568 空=[552/818/638]、大=[689/998/831]，中位数差 192.9ms；而同一份
 * main 代码（commit 4ac97563）在另一台 runner 上空目录首帧从 552 跳到 1472、差值 156ms。
 * 3 轮的单次值方差就有 2~3 倍，各自取中位数还在抖，相减等于拿两份噪声做差。
 *
 * 配对之后，轮间的整体漂移（机器变慢 / 邻居抢 CPU）在减法里消失，剩下的才是
 * 「同一轮内大数据目录多做了多少活」—— 也就是这个门禁真正要量的东西。
 */
function pairedDelta(
  runs: Record<Config, Profile[]>,
  which: Exclude<Config, "empty">,
  probe: (p: Profile) => number,
): number[] {
  return runs.empty.map((p, i) => probe(runs[which][i]!) - probe(p));
}

/** 差值数组摊平成一串（失败时看逐轮），与 spread 同款用途 */
const spreadOf = (xs: number[]) => xs.map((x) => Math.round(x)).join(" / ");

/** 把多次启动收成一个「中位数 Profile」（只保留门禁用到的两个口径） */
function medianProfile(ps: Profile[]): Profile {
  return {
    checkpoints: [{ name: "first_frame", ms: median(ps.map(firstFrame)) }],
    metrics: { max_loop_block_before_interactive: median(ps.map(maxBlock)) },
  };
}

const firstFrame = (p: Profile) => p.checkpoints.find((c) => c.name === "first_frame")?.ms ?? NaN;
const maxBlock = (p: Profile) => p.metrics.max_loop_block_before_interactive ?? NaN;

/**
 * 把一组测量值摊平成一串。中位数会掩盖方差：失败时要能看出是「单次离群」还是「整组偏移」，
 * 否则只能靠重跑去猜（macOS CI 那两次 224.6 / 351.2ms 就没法区分）。
 */
const spread = (ps: Profile[]) => ps.map((p) => Math.round(firstFrame(p))).join(" / ");

/** 同上，取事件循环最大阻塞那一列 */
const spreadBlock = (ps: Profile[]) => ps.map((p) => Math.round(maxBlock(p))).join(" / ");

/** 相对 beforeAll 起点的时间戳（ms），日志里用「+1234」而不是绝对毫秒，方便和轮次窗口对时间 */
const rel = (ms: number) => `${ms >= 0 ? "+" : ""}${Math.round(ms)}`;

// Windows 没有 pty（Bun.Terminal 仅 POSIX）；CI 只跑 ubuntu / macos
const describeGate = process.platform === "win32" ? describe.skip : describe;

describeGate("大数据启动门禁（首帧与事件循环阻塞不随数据量增长）", () => {
  let empty: Profile;
  let large: Profile;
  let bigSession: string;
  let expiredProbe: string;
  let largeHome: string;
  let uploadHome: string;
  let uploadSessionDir: string;
  /** 三组的单次值：中位数掩盖方差，红的时候要能看出是「一次离群」还是「整组偏移」 */
  let emptyRuns: Profile[] = [];
  let largeRuns: Profile[] = [];
  let uploadRuns: Profile[] = [];
  /** 三组的逐轮样本，配对差值的输入（按轮次索引一一对应） */
  function runsOf(): Record<Config, Profile[]> {
    return { empty: emptyRuns, large: largeRuns, upload: uploadRuns };
  }
  /**
   * 每轮的时间线与原始值。
   *
   * 门禁在 macOS 上红了 5 次、绿了若干次，中位数日志没法区分三种候选根因
   * （l1 被上一轮的子进程抬高 / l0 冷读 / 整轮噪声）。这一份是它们的判决输入：
   * 红的时候把「哪一轮、三组各是多少、大目录子进程当时在不在跑」直接打进日志。
   */
  let traces: RoundTrace[] = [];
  /** 大数据目录的维护子进程结果（只有第一轮会起，几轮里读到同一份就说明它没再跑过） */
  let largeMaint: MaintSummary | undefined;
  /**
   * 收到请求立刻回 502（与 10-22 真实失败同一状态码）。
   *
   * 不用「只挂住不响应」：维护子进程会卡在 30s 超时上一直持有单实例锁，后几轮启动的子进程
   * 抢不到锁、整轮跳过补传，门禁因此空转（第一版就是这样）。要量的阻塞（整份压缩、整份 parse）
   * 都发生在 fetch 之前，与服务端多久回包无关。
   */
  let hangServer: ReturnType<typeof Bun.serve>;
  let hangHits = 0;

  beforeAll(async () => {
    hangServer = Bun.serve({
      port: 0,
      async fetch(req) {
        hangHits++;
        await req.arrayBuffer().catch(() => {});
        return new Response("bad gateway", { status: 502 });
      },
    });
    const emptyHome = makeHome();
    largeHome = makeHome();
    ({ bigSession, expiredProbe } = populateLargeHome(largeHome));
    uploadHome = makeHome({
      // 必须显式 enabled：用户写了 trace 对象就整体覆盖默认的 {enabled:true}，
      // 不写时采集与补传都不启用（与 initTraceCollector 同口径）——第一版漏了，补传用例空转。
      trace: {
        enabled: true,
        upload: { url: `http://127.0.0.1:${hangServer.port}/traj`, token: "tok", max_retries: 1 },
      },
    });
    uploadSessionDir = populateUploadHome(uploadHome);
    // 先热一次：bun 的转译缓存会让第一次启动整体偏慢，不热的话差值方向会反过来掩盖退化
    const warmHome = makeHome();
    await startOnce(warmHome);
    // 热启动也会拉起维护子进程（housekeeping 到期）。它 detached + unref，TUI 退出后仍在跑，
    // 会和轮 0 抢 CPU —— 所以热启动这一份也要等干净，否则隔离只隔了一半。
    await waitMaintenanceIdle(warmHome);

    /** 墙钟基准：maintenance-result.json 的 startedAt/finishedAt 是 epoch ms，减它能和轮次窗口对上 */
    const wallStart = Date.now();
    const homesByConfig: Record<Config, string> = {
      empty: emptyHome,
      large: largeHome,
      upload: uploadHome,
    };
    // 交替各跑 RUNS 次取中位数：单次 first_frame 实测有 ~250ms 的偶发离群（机器抖动），
    // 单次差值会把它当成退化或把退化抵消掉。
    const e: Profile[] = [];
    const l: Profile[] = [];
    const u: Profile[] = [];
    for (let i = 0; i < RUNS; i++) {
      const from = Date.now() - wallStart;
      // 采样必须在等待之前：等完再采样必然是 false，就看不出这一轮原本被测在什么环境里
      const largeBusyAtStart = existsSync(join(largeHome, "state", "maintenance.lock"));

      // 隔离（本次修复的核心）：从轮 1 起，先把上一轮三个目录拉起的维护子进程全等干净再开始测。
      //
      // 子进程是 detached + unref 的（maintenance/launcher.ts），TUI 退出后继续扫 300 个会话、
      // 读 200MB 巨型会话、扫 1500 个轨迹目录。原来只等 uploadHome（补传那一路），大数据目录
      // 首轮拉起的那个无人等 —— 它跨轮压在 e1/l1 上，macOS runner 上把首帧差值抬到
      // 211.9 / 293.6ms（阈值 150）。轮 0 之前没有任何启动（热启动那份已在上面等到），
      // 三个目录都还没起过子进程，等它们是白等宽限期，所以从轮 1 开始。
      if (i > 0) {
        await waitMaintenanceIdle(emptyHome);
        await waitMaintenanceIdle(largeHome);
        await waitMaintenanceIdle(uploadHome);
      }

      // 顺序轮转：三种配置在三个位置上各占一次（见 ROUND_ORDER 的注释）。
      // 上传目录的记账清理必须在它启动前做：不清的话只有第一轮真的去补传。
      const measured = new Map<Config, Profile>();
      for (const which of ROUND_ORDER[i % ROUND_ORDER.length]!) {
        if (which === "upload") resetUploadState(uploadHome, uploadSessionDir);
        measured.set(which, await startOnce(homesByConfig[which]));
      }
      const eOne = measured.get("empty")!;
      const lOne = measured.get("large")!;
      const uOne = measured.get("upload")!;
      e.push(eOne);
      l.push(lOne);
      u.push(uOne);
      traces.push({
        round: i,
        from,
        to: Date.now() - wallStart,
        frame: { empty: firstFrame(eOne), large: firstFrame(lOne), upload: firstFrame(uOne) },
        block: { empty: maxBlock(eOne), large: maxBlock(lOne), upload: maxBlock(uOne) },
        largeBusyAtStart,
        largeBusyAtEnd: existsSync(join(largeHome, "state", "maintenance.lock")),
      });
      // 大数据目录只有轮 0 会起子进程（跑完就写水位线，之后 24h 内不再到期），
      // 所以这里读到的一直是同一份；`?? largeMaint` 防的是「这一轮刚好还没写完」的中间态。
      largeMaint = readMaintSummary(largeHome) ?? largeMaint;
    }
    emptyRuns = e;
    largeRuns = l;
    uploadRuns = u;
    empty = medianProfile(e);
    large = medianProfile(l);
    logRoundTraces(traces, largeMaint, wallStart);
  }, 400_000);

  /**
   * 清理必须给显式超时：默认 5s 删不完这一套 fixture。
   *
   * homes 里累积了 4 个 home 目录，其中 large / upload 两个各含 200MB 大文件，
   * 还有 1500 个轨迹目录 × 20 个小文件（合计约 3 万个小文件、400MB）。
   * macOS(APFS) 上 1s 内删完，ubuntu runner 的磁盘上超过 5s —— PR #521 的 CI 里
   * 7 条子断言全过，却因这条 hook 超时把整条测试判红：
   * `(unnamed) [5058.67ms]` + `a beforeEach/afterEach hook timed out for this test.`
   * （5.06s 与默认超时吻合；bun 把 afterAll 的超时也归到这句措辞里）
   *
   * 删临时目录快慢不是这里要断言的东西，不该让它决定门禁红绿。
   */
  afterAll(() => {
    hangServer?.stop(true);
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  }, 180_000);

  test("两次启动都拿到了口径（防门禁空转）", () => {
    expect(Number.isFinite(firstFrame(empty))).toBe(true);
    expect(Number.isFinite(firstFrame(large))).toBe(true);
    expect(Number.isFinite(maxBlock(empty))).toBe(true);
    expect(Number.isFinite(maxBlock(large))).toBe(true);
  });

  /**
   * 结构性门禁：首帧前主进程没有调用任何「该在维护子进程里跑」的入口。
   *
   * 这是 macOS 计时断言降级为只报告后补回的检出能力：判据是确定性的 0，不吃 runner 负载，
   * 两个平台都阻断。入口打点见 `shared/utils/startup-profiler.ts` 的 profileCounter：
   *
   * - `session-cleanup`：全量扫描会话目录（C1 变异放回主线程时 +1）；
   * - `trace-prune` / `trace-prune-stale`：全量扫描轨迹目录（T1/T2 变异放回 collector
   *   构造函数时 +1）；
   * - `trace-upload-compress`：补传压缩（U1–U4 变异放回 SessionStart 时 +1）。
   *
   * 判据是「三种配置的每一轮都为 0」，不是「差值小于阈值」：正常启动时这三类入口
   * 一次都不该被主进程调用，出现任何一次都是有活回到了首帧前。
   */
  test("首帧前主进程没调用维护任务入口（结构性门禁，与 runner 负载无关）", () => {
    const cases: Array<[string, Profile[]]> = [
      ["空", emptyRuns],
      ["大数据", largeRuns],
      ["补传", uploadRuns],
    ];
    for (const [cfg, runs] of cases) {
      runs.forEach((p, i) => {
        const counters = p.counters ?? {};
        expect(
          { 配置: cfg, 轮: i, counters },
          `首帧前调用了维护任务入口（${cfg} 目录第 ${i} 轮）：${JSON.stringify(counters)}`,
        ).toEqual({ 配置: cfg, 轮: i, counters: {} });
      });
    }
  });

  // 平台分支本身必须被锁住：`if (platform !== "darwin") expect(...)` 这种写法把断言包起来
  // 却没有对应断言锁分支，哪天有人把 ubuntu 也改成只报告，所有计时断言照样全绿。
  test("计时断言按平台分档：macOS 只报告，其他平台阻断", () => {
    expect(timingAssertionsBlocking("darwin")).toBe(false);
    expect(timingAssertionsBlocking("linux")).toBe(true);
    expect(timingAssertionsBlocking("win32")).toBe(true);
    expect(TIMING_BLOCKING).toBe(timingAssertionsBlocking(process.platform));
  });

  // max_loop_block 取的是**最大值**：一段 100ms 级的扫描与空目录本来就有的 ~90ms 常数阻塞
  // 取 max 后几乎看不出来（T1 放回 collector 构造的变异就是这样漏过去的），
  // 所以首帧差值才是「首帧前多做了多少活」的主口径，阈值必须收紧。
  // 标定：修复后 +18 ~ +142ms（单次离群已被中位数吸收），C1 变异 +698ms，T1/T2 变异 +353ms。
  //
  // 判据口径（2026-11-04）：差值改为**逐轮配对**后的中位数，不再拿两组各自的中位数相减——
  // 后者两个数来自不同的轮次，轮间整机漂移直接进了差值，macOS runner 因此假红过两次
  // （PR #568 空 552/818/638、大 689/998/831 → 192.9ms；main 4ac97563 → 156ms）。
  // 阈值（2026-11-06 起）：ubuntu / 本机仍按 150ms 阻断；macOS 只报告（见 timingAssertionsBlocking）。
  test("首帧：大数据比空目录慢不超过阈值（逐轮配对差值的中位数，macOS 只报告）", () => {
    const deltas = pairedDelta(runsOf(), "large", firstFrame);
    assertTiming(
      "首帧(大−空)",
      median(deltas),
      FRAME_DELTA_LIMIT_MS,
      `逐轮 Δframe=[${spreadOf(deltas)}]；first_frame 空=[${spread(emptyRuns)}] 大=[${spread(largeRuns)}]`,
    );
  });

  // 阈值标定（2026-11-01 本机，3 轮中位数）：修复后 max_block 差值 −13 ~ +15ms；
  // 变异自证：C1 全量会话清理放回主线程 +570ms，T1/T2 放回 collector 构造 +300ms。
  // 口径同上：逐轮配对后的中位数；平台口径同上一条（macOS 只报告，ubuntu / 本机 100ms 阻断）。
  test("事件循环最大阻塞：大数据比空目录多不超过阈值（逐轮配对差值的中位数，macOS 只报告）", () => {
    const deltas = pairedDelta(runsOf(), "large", maxBlock);
    assertTiming(
      "事件循环最大阻塞(大−空)",
      median(deltas),
      BLOCK_DELTA_LIMIT_MS,
      `逐轮 Δblock=[${spreadOf(deltas)}]；max_loop_block 空=[${spreadBlock(emptyRuns)}] 大=[${spreadBlock(largeRuns)}]`,
    );
  });

  test("绝对兜底：首帧 < 3s", () => {
    expect(firstFrame(large)).toBeLessThan(3000);
  });

  test("维护任务确实在子进程里跑了（过期会话被删、结果文件落盘）", async () => {
    const result = join(largeHome, "state", "maintenance-result.json");
    const deadline = performance.now() + 60_000;
    while (!existsSync(result) && performance.now() < deadline) await Bun.sleep(200);
    expect(existsSync(result), "维护子进程 60s 内没写结果文件").toBe(true);
    const r = JSON.parse(readFileSync(result, "utf-8"));
    expect(r.tasks["session-cleanup"]?.ok).toBe(true);
    expect(r.tasks["trace-prune"]?.ok).toBe(true);
    // 过期探针被子进程删掉；30 天前的巨型会话在保留期内，必须还在（也保证多轮启动都扫到它）
    expect(existsSync(expiredProbe)).toBe(false);
    expect(existsSync(bigSession)).toBe(true);
  }, 70_000);

  // U1–U4：口径与上面两条同一套（ubuntu / 本机阻断，macOS 只报告）。修复前补传在
  // SessionStart 里 fire-and-forget，gzipSync 200MB 是秒级同步阻塞，落在首帧前后 3s 窗口内。
  test("补传（U1–U4）不在 TUI 主线程：配了上传的大 traj 目录，首帧与最大阻塞不随它增长", () => {
    const dFrames = pairedDelta(runsOf(), "upload", firstFrame);
    const dBlocks = pairedDelta(runsOf(), "upload", maxBlock);
    console.log(`[gate] upload 逐轮 Δframe=[${spreadOf(dFrames)}] Δblock=[${spreadOf(dBlocks)}]`);
    assertTiming(
      "补传首帧(传−空)",
      median(dFrames),
      FRAME_DELTA_LIMIT_MS,
      `逐轮 Δframe=[${spreadOf(dFrames)}]；first_frame 空=[${spread(emptyRuns)}] 上传=[${spread(uploadRuns)}]`,
    );
    assertTiming(
      "补传阻塞(传−空)",
      median(dBlocks),
      BLOCK_DELTA_LIMIT_MS,
      `逐轮 Δblock=[${spreadOf(dBlocks)}]；max_loop_block 空=[${spreadBlock(emptyRuns)}] 上传=[${spreadBlock(uploadRuns)}]`,
    );
  });

  // 防空转：补传确实在子进程里跑了——压缩缓存落盘、请求打到了挂起的 server。
  // 没有这条，「上传没配上 / 补传判据把会话跳过了」也会让上一条恒绿。
  test("补传确实在维护子进程里发生（压缩缓存落盘、请求到达 server、失败已记账）", async () => {
    const attempts = join(uploadSessionDir, ".upload-attempts");
    const cache = join(uploadSessionDir, ".upload-cache", "session.traj.gz");
    const deadline = performance.now() + 60_000;
    while (
      (!existsSync(cache) || hangHits === 0 || !existsSync(attempts)) &&
      performance.now() < deadline
    ) {
      await Bun.sleep(200);
    }
    expect(existsSync(cache), "60s 内没看到压缩缓存：补传没跑或没选中这个会话").toBe(true);
    expect(hangHits, "60s 内上传请求没到达 server").toBeGreaterThan(0);
    // U4：502 被记进会话目录（下次按退避跳过，不再每次启动重来）
    expect(existsSync(attempts), "失败没写 .upload-attempts").toBe(true);
  }, 70_000);
});
