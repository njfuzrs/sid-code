/**
 * release.sh：缺 curated 文案时的放行判据（X3-08 回归）。
 *
 * ## 缺陷形态
 *
 * 缺 `changelog/curated/v<ver>.json` 时，旧实现按 **stdin 是不是终端**决定要不要确认：
 * 有 tty 就弹确认门，没有就 `warn "非交互环境，跳过确认，继续发布"` 然后继续发。
 * 于是「缺用户文案照样发」这个决定**由调用环境替人做出**——而 agent / 自动化 /
 * `</dev/null` 调起时天生没有 tty，这条路径对所有无人值守调用永久放行，
 * 日志里只有一行 warn，看起来像一次合理的降级。
 *
 * ## 为什么这么测
 *
 * 不跑整条 release.sh（要 bump、全量测试、5 平台构建、服务器），而是把 curated
 * 前置检查**那一段原样切出来**，注入变量与 helper 后真执行。
 * 断言的是**实际退出码与输出**，不是源码里有没有某个字面量——
 * 后者只能证明「作者写过这段」，证明不了「被守护的行为坏了它会红」
 * （本仓 X3-14 就是这类文本断言的受害者）。
 *
 * 每条行为断言都配一条变异自证：把被测的那行改坏，确认断言真的会红。
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const RELEASE_SH = readFileSync(join(ROOT, "scripts/release.sh"), "utf8");

const START_MARK = '_CURATED_FILE="changelog/curated/v${VERSION}.json"';
const END_MARK = 'ok "已有用户视角文案：$_CURATED_FILE"';

/**
 * 切出 curated 前置检查整段（`_CURATED_FILE=…` 到 `fi`）。
 *
 * 切不出来就抛错而不是返回空串：静默返回空串会让下面每条断言都跑在一个空脚本上，
 * 「全绿但什么都没测」——正是这批缺陷共同的失效形态。
 */
function sliceCuratedGate(): string {
  const start = RELEASE_SH.indexOf(START_MARK);
  if (start < 0) throw new Error(`release.sh 里找不到 ${START_MARK} —— 这段被改名或挪位了`);
  const end = RELEASE_SH.indexOf(END_MARK, start);
  if (end < 0) throw new Error(`release.sh 里找不到 ${END_MARK} —— curated 段结尾变了`);
  return `${RELEASE_SH.slice(start, end + END_MARK.length)}\nfi\n`;
}

/** bash 单引号转义（tmpdir 路径可能含空格 / $ 等字符）。 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface RunOptions {
  /** 目标版本在 ROOT 下有没有 curated 文件 */
  hasCurated: boolean;
  /** 模拟 `--allow-no-curated` */
  allowNoCurated?: boolean;
  /** 对切出来的代码段做变异（用于变异自证） */
  mutate?: (body: string) => string;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 真跑 curated 检查段。
 *
 * stdin 用 pipe（不是 /dev/null 只是为了可断言，关键是它**不是 tty**），
 * 于是脚本里的 `[ -t 0 ]` 为假 —— 与 agent / CI 调起时的处境一致。
 */
function runCuratedGate(opts: RunOptions): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "sid-curated-gate-"));
  if (opts.hasCurated) {
    mkdirSync(join(dir, "changelog/curated"), { recursive: true });
    writeFileSync(join(dir, "changelog/curated/v0.1.999.json"), "{}\n");
  }

  let body = sliceCuratedGate();
  if (opts.mutate) body = opts.mutate(body);

  const script = [
    "set -euo pipefail",
    `ROOT=${shq(dir)}`,
    "VERSION=0.1.999",
    "BETA_FIX=false",
    'BETA_NOTE=""',
    `ALLOW_NO_CURATED=${opts.allowNoCurated ? "true" : "false"}`,
    `SCRIPT_DIR=${shq(join(dir, "scripts"))}`,
    // helper 与 release.sh 里的定义保持同签名（fail 必须非 0 退出）
    'info() { echo "  $*"; }',
    'ok() { echo "  ✅ $*"; }',
    'warn() { echo "  ⚠️  $*" >&2; }',
    'fail() { echo "  ❌ $*" >&2; exit 1; }',
    body,
  ].join("\n");

  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    // stdin 是管道（fs 0 不是 tty）；显式给空 input，避免继承父进程的终端
    input: "",
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("release.sh 缺 curated：非交互环境不再降级放行（X3-08）", () => {
  test("缺文案 + 非交互 + 没有 --allow-no-curated → 拒绝发布（非 0 退出）", () => {
    const r = runCuratedGate({ hasCurated: false });
    expect(r.status).not.toBe(0);
    // 报错必须点出两条出路，否则读日志的人只知道"发不出去"。
    // 两条出路里一条走 info（stdout）、一条在 fail 文案（stderr），所以查合并输出。
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toContain("--allow-no-curated");
    expect(out).toContain("--no-bump");
  });

  test("缺文案 + 非交互 + --allow-no-curated → 放行，且日志写明「已显式放弃」", () => {
    const r = runCuratedGate({ hasCurated: false, allowNoCurated: true });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("已显式放弃");
    // 放行必须是可见的声明：只出现「已显式放弃」，不再出现旧的静默降级话术
    expect(`${r.stdout}${r.stderr}`).not.toContain("跳过确认");
  });

  test("已有文案 → 直接通过（回归：这条分支不能被上面的改动误伤）", () => {
    const r = runCuratedGate({ hasCurated: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("已有用户视角文案");
  });

  test("变异自证：把非交互分支的 fail 改回 warn 继续，第一条断言必须变红", () => {
    const r = runCuratedGate({
      hasCurated: false,
      mutate: (body) => body.replace('fail "非交互环境缺', 'warn "非交互环境缺'),
    });
    // 改坏之后退出码变成 0 —— 说明上面那条 `toBe(0)`/`not.toBe(0)` 断言确实在测行为
    expect(r.status).toBe(0);
  });

  test("变异自证：去掉 --allow-no-curated 分支，第二条断言必须变红", () => {
    const r = runCuratedGate({
      hasCurated: false,
      allowNoCurated: true,
      mutate: (body) => body.replace('if [ "$ALLOW_NO_CURATED" = true ]; then', "if false; then"),
    });
    expect(r.status).not.toBe(0);
  });
});

describe("release.sh 缺 curated：flag 接线（防「声明了但没接上」）", () => {
  test("--allow-no-curated 被参数解析消费，且默认 false", () => {
    expect(RELEASE_SH).toContain("--allow-no-curated) ALLOW_NO_CURATED=true; shift ;;");
    expect(RELEASE_SH).toMatch(/^ALLOW_NO_CURATED=false$/m);
  });

  test("flag 优先于 tty 探测（否则 agent 调起时仍然永远走不到它）", () => {
    const body = sliceCuratedGate();
    const flagPos = body.indexOf('if [ "$ALLOW_NO_CURATED" = true ]; then');
    const ttyPos = body.indexOf("[ -t 0 ]");
    expect(flagPos).toBeGreaterThan(0);
    expect(ttyPos).toBeGreaterThan(0);
    expect(flagPos).toBeLessThan(ttyPos);
  });

  test("交互分支仍然保留（有 tty 的人不该被迫先加 flag）", () => {
    const body = sliceCuratedGate();
    // 判据必须同时要求「stdin 是终端」，不能只判 `/dev/tty` 存在：
    // agent / 自动化进程常常有 /dev/tty 设备节点却没人应答，
    // 只判存在会从「假绿」变成「挂死」（见缺陷文档 X3-08 修复方案第 3 条）。
    expect(body).toMatch(/\[ -t 0 \] && \[ -e \/dev\/tty \]/);
    expect(body).toContain("read -r _ans </dev/tty");
  });

  test("脚本头部用法里写明了这个 flag（否则没人会想到它存在）", () => {
    expect(RELEASE_SH).toContain("./scripts/release.sh --allow-no-curated");
  });
});

describe("scripts/RELEASE.md 与实现同步（防文档说降级、实现已拒绝）", () => {
  const md = readFileSync(join(ROOT, "scripts/RELEASE.md"), "utf8");

  test("不再声称非交互环境会「降级为 warn 直接过」", () => {
    expect(md).not.toContain("降级为 warn");
    expect(md).not.toContain("非交互环境（管道 / CI）会降级");
  });

  test("写明了非交互直接拒绝与 --allow-no-curated 这条路", () => {
    expect(md).toContain("--allow-no-curated");
    expect(md).toContain("拒绝");
  });
});
