/**
 * 可自定义状态栏执行层（P1-5，对标 claude-code statusLine）
 *
 * 职责：把会话数据组装成 JSON，经 stdin 喂给用户配置的 shell 脚本，脚本 stdout 即
 * 状态栏内容（支持 ANSI 颜色）。核心约束：
 * - 超时保护（默认 1s）：坏脚本绝不能卡死 UI；超时/失败一律回退内置状态栏（返回 null）。
 * - stderr 不污染 UI：只取 stdout，stderr 丢弃（仅调试日志）。
 * - 单例节流：同一命令 + 同一数据指纹在 THROTTLE_MS 内复用上次结果，避免每帧 spawn。
 *
 * 数据协议（stdin JSON）对标 cc：workspace/model/context/cost 等扁平字段，
 * 便于用户脚本用 `jq` 直接取。
 */

import { spawn } from "node:child_process";
import { getLogger } from "../../debug/logger.ts";

/** 传给用户脚本的会话数据（stdin JSON）。字段对标 cc statusLine 输入。 */
export interface StatusLineSessionData {
  /** 当前工作目录（绝对路径） */
  cwd: string;
  /** 当前 git 分支 */
  gitBranch: string;
  /** git worktree 名（非 worktree 时为空串） */
  worktree: string;
  /** 权限模式（default/plan/dangerously-skip-permissions...） */
  permissionMode: string;
  /** 当前模型名 */
  model: string;
  /** 末次输入 token（stock 口径，近似当前上下文大小） */
  inputTokens: number;
  /** 累计输出 token */
  outputTokens: number;
  /** 上下文使用率百分比（0-100） */
  contextPercent: number;
  /** 会话累计费用（美元） */
  costUSD: number;
  /** 缓存命中率百分比（0-100，无缓存为 0） */
  cacheHitRate: number;
  /** 推理强度档位（low/medium/high/... 或 auto；不支持为空串） */
  effort: string;
  /** 思考开关是否开启 */
  thinking: boolean;
}

/** statusLine 配置（来自 settings.statusLine）。 */
export interface StatusLineConfig {
  type?: "command";
  command?: string;
  padding?: number;
}

/** 默认脚本超时（ms）。坏脚本超时即回退，绝不卡 UI。 */
export const STATUSLINE_TIMEOUT_MS = 1000;
/** 节流窗口（ms）：同指纹结果复用，避免高频 spawn 外部进程。 */
export const STATUSLINE_THROTTLE_MS = 300;

interface CacheEntry {
  fingerprint: string;
  output: string;
  at: number;
}
let cache: CacheEntry | null = null;

/** 数据指纹：命令 + 关键会话字段。字段变了才重跑脚本。 */
function fingerprint(command: string, data: StatusLineSessionData): string {
  return [
    command,
    data.cwd,
    data.gitBranch,
    data.worktree,
    data.permissionMode,
    data.model,
    data.inputTokens,
    data.outputTokens,
    data.contextPercent,
    data.costUSD.toFixed(4),
    data.cacheHitRate,
    data.effort,
    data.thinking ? "1" : "0",
  ].join("");
}

/**
 * 跑用户状态栏脚本。返回脚本 stdout（trim 尾换行），失败/超时/无配置返回 null（调用方回退内置）。
 *
 * @param config settings.statusLine 配置
 * @param data   会话数据（序列化为 stdin JSON）
 * @param nowMs  当前时间戳（ms）。由调用方传入（避免模块内直接读时钟，便于测试）。
 */
export async function runStatusLine(
  config: StatusLineConfig | undefined,
  data: StatusLineSessionData,
  nowMs: number,
): Promise<string | null> {
  const command = config?.command?.trim();
  if (!config || config.type !== "command" || !command) return null;

  const fp = fingerprint(command, data);
  // 节流：指纹未变且在窗口内 → 复用上次输出。
  if (cache && cache.fingerprint === fp && nowMs - cache.at < STATUSLINE_THROTTLE_MS) {
    return cache.output;
  }

  const log = getLogger();
  const payload = JSON.stringify(data);

  const output = await new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (val: string | null) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    let child: ReturnType<typeof spawn>;
    try {
      // 经 shell 执行，支持用户写 "my-script.sh" / "jq ..." 等。stdin 喂 JSON。
      child = spawn(command, {
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      log.warn("UI:STATUSLINE", `spawn 失败: ${String(e)}`);
      finish(null);
      return;
    }

    const chunks: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => chunks.push(d));
    // stderr 只吞不显（避免污染 UI），调试时可看日志。
    child.stderr?.on("data", () => { /* 丢弃 */ });

    // 超时保护：到点强杀，回退内置。
    const timer = setTimeout(() => {
      log.warn("UI:STATUSLINE", `脚本超时 ${STATUSLINE_TIMEOUT_MS}ms，回退内置状态栏`);
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      finish(null);
    }, STATUSLINE_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      log.warn("UI:STATUSLINE", `脚本执行错误: ${String(err)}`);
      finish(null);
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        log.warn("UI:STATUSLINE", `脚本非零退出 (${code})，回退内置状态栏`);
        finish(null);
        return;
      }
      // 只取首行有意义内容，去尾换行；状态栏是单行。
      const text = Buffer.concat(chunks).toString("utf8").replace(/\n+$/, "");
      finish(text);
    });

    // 写 stdin 后关闭，触发脚本读取。
    try {
      child.stdin?.write(payload);
      child.stdin?.end();
    } catch {
      // 脚本可能不读 stdin 就退出，忽略 EPIPE。
    }
  });

  if (output !== null) {
    cache = { fingerprint: fp, output, at: nowMs };
  }
  return output;
}

/** 清空节流缓存（测试/配置热更新用）。 */
export function clearStatusLineCache(): void {
  cache = null;
}
