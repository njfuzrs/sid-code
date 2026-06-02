/**
 * 同步输出能力探测 — P0-5 / §3.1
 *
 * 重要说明:
 * 实际的同步输出帧包裹(BSU/ESU `\x1b[?2026h/l`)已由渲染依赖
 * `@jrichman/ink` fork 在 log-update 层负责(enableSynchronizedOutput=true),
 * sid-code 无需也不应在应用层重复包裹帧 —— 那会与 fork 双重发送转义序列。
 *
 * 本模块只提供"当前终端是否声称支持同步输出"的**纯逻辑判断**,
 * 供诊断、能力上报、以及未来需要按终端能力分支的逻辑使用(例如
 * 决定是否启用某些高刷新动画)。不产生任何终端副作用。
 */

/**
 * 比较两个点分版本号。
 * 返回 >0 表示 a>b,<0 表示 a<b,0 表示相等。
 * 缺失段按 0 处理;非数字段按 0 处理(宽松解析,避免抛错)。
 */
export function compareVersions(
  a: string | undefined,
  b: string | undefined,
): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function parseVersion(v: string | undefined): number[] {
  if (!v) return [];
  return v
    .split(".")
    .map((seg) => {
      const n = parseInt(seg, 10);
      return Number.isNaN(n) ? 0 : n;
    });
}

export interface SyncOutputEnv {
  TERM_PROGRAM?: string;
  TERM_PROGRAM_VERSION?: string;
  ConEmuPID?: string;
  TERM?: string;
}

/**
 * 判断终端是否支持 DEC 2026 同步输出。
 * 已知支持:Ghostty 1.2+、iTerm2 3.6.6+、ConEmu、WezTerm、foot、kitty。
 * 纯函数:显式接收 env,便于单测。
 */
export function isSynchronizedOutputSupported(
  env: SyncOutputEnv = process.env as SyncOutputEnv,
): boolean {
  const term = (env.TERM_PROGRAM ?? "").toLowerCase();
  const version = env.TERM_PROGRAM_VERSION;
  const termType = (env.TERM ?? "").toLowerCase();

  if (env.ConEmuPID) return true;

  if (term.includes("ghostty")) {
    return compareVersions(version, "1.2.0") >= 0;
  }
  if (term === "iterm.app") {
    return compareVersions(version, "3.6.6") >= 0;
  }
  if (term.includes("wezterm")) return true;

  // 基于 TERM 的兜底识别(foot / kitty 等常通过 TERM 暴露)
  if (termType.includes("foot")) return true;
  if (termType.includes("kitty")) return true;

  return false;
}
