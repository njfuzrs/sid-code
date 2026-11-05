/**
 * 诊断屏障（barrier）：把「服务器已按序处理完 didChange」变成一个可观测的因果信号。
 *
 * ## 为什么需要
 *
 * `publishDiagnostics` 的 version 是协议可选项。typescript-language-server 5.x 不在推送里带
 * （源码 `FileDiagnostics.publishDiagnostics()` 只发 `{ uri, diagnostics }`，见 cli.mjs:19866），
 * 于是「didChange 已发出、服务器仍在推旧内容诊断」这段（S1）此前没有任何防线：
 * 无 version 可比，而编辑同步窗口在 didChange 发出的那一刻就结束了。
 *
 * 屏障的做法：didChange 之后紧跟一个廉价请求（`textDocument/documentSymbol`），它的响应
 * 到达即证明服务器**已按序处理完** didChange——JSON-RPC over stdio 单连接上的通知与请求
 * 按发送顺序到达，服务器能产生屏障响应，就必然已应用了之前的 didChange。
 * 请求本身不 await，不阻塞 edit 工具。
 *
 * ## 为什么还必须再加一个 flush 窗口
 *
 * 这一点是实测推翻设计假设的地方，不能省（否则判据会漏）：
 *
 * 屏障响应只证明「didChange 已处理」，**不证明「基于旧内容的推送都已发出」**。
 * tsls 的 `FileDiagnostics` 用 `pDebounce(..., 50)` 合并推送（cli.mjs:19857）：定时器可能在
 * didChange 之前就已排队，到期后才推——它不看 didChange。
 *
 * 2026-11-05 本机实测（6000 行文件，30 次采样，T 取 340–580ms 覆盖 syntax/semantic 两个阶段）：
 * - 旧内容推送最晚在**屏障响应之后 48ms** 才到达（多次 +5ms / +48ms 的正值）；
 * - 新内容推送最早在**屏障响应之后 172ms** 到达。
 *
 * 所以屏障响应后要再等一个 flush 窗口才认定「旧代际已排空」。默认 100ms 落在这两个实测
 * 数字之间：既排空旧推送，又不会把新代际的第一条推送误当旧内容丢掉。
 *
 * 这两个数字只覆盖 tsls 5.1.3。其它无 version 的服务器若乱序处理通知，屏障判据会失效，
 * 所以 e2e（`packages/core/tests/lsp/e2e/`）必须对每个打算启用屏障的服务器各跑一遍，
 * 没跑过的服务器默认判 unverified。
 */

import { getLogger } from "../debug/logger.ts";

/** 屏障请求超时。超时即判失败：结束同步窗口、后续推送降级为 unverified（退化为修复前行为） */
export const BARRIER_TIMEOUT_MS = 3000;

/** 屏障响应之后的 flush 窗口，取值依据见文件头注释 */
export const BARRIER_FLUSH_MS = 100;

/**
 * 同一服务器连续失败多少次后关闭屏障。
 * 目的是避免对「不支持 documentSymbol」的服务器每次编辑都白发一个请求。
 */
export const BARRIER_MAX_CONSECUTIVE_FAILURES = 3;

export interface BarrierGateOptions {
  timeoutMs?: number;
  flushMs?: number;
  maxConsecutiveFailures?: number;
}

export class BarrierGate {
  private readonly timeoutMs: number;
  private readonly flushMs: number;
  private readonly maxConsecutiveFailures: number;
  /** serverName → 连续失败次数（成功即清零） */
  private consecutiveFailures = new Map<string, number>();
  /** 已关闭屏障的服务器。刻意不在成功时恢复——它一次都没成功过 */
  private disabled = new Set<string>();

  constructor(opts: BarrierGateOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? BARRIER_TIMEOUT_MS;
    this.flushMs = opts.flushMs ?? BARRIER_FLUSH_MS;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? BARRIER_MAX_CONSECUTIVE_FAILURES;
  }

  /** 屏障请求超时（毫秒）。调用方发请求时传给 sendRequest */
  get timeout(): number {
    return this.timeoutMs;
  }

  /** 该服务器的屏障是否已被关闭（连续失败超限） */
  isDisabled(serverName: string): boolean {
    return this.disabled.has(serverName);
  }

  /**
   * 跑一次屏障。
   *
   * @param serverName 服务器名（失败计数按服务器分开记）
   * @param send 真正发出屏障请求；由调用方绑定 server instance 与 uri
   * @returns true = 服务器已处理完本次变更**且** flush 窗口已越过（可以认定之后的推送是新代际）；
   *          false = 失败 / 该服务器屏障已关闭（调用方据此降级为 unverified）
   */
  async run(serverName: string, send: () => Promise<unknown>): Promise<boolean> {
    if (this.disabled.has(serverName)) return false;

    try {
      await send();
    } catch (err) {
      const n = (this.consecutiveFailures.get(serverName) ?? 0) + 1;
      this.consecutiveFailures.set(serverName, n);
      if (n >= this.maxConsecutiveFailures) {
        this.disabled.add(serverName);
        getLogger().debug(
          "LSP",
          `[${serverName}] 屏障连续失败 ${n} 次，已关闭该服务器的诊断屏障（推送降级为 unverified）: ${
            (err as Error)?.message
          }`,
        );
      }
      return false;
    }

    this.consecutiveFailures.delete(serverName);
    if (this.flushMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.flushMs));
    }
    return true;
  }

  /** 重置全部状态（LSP 重启 / 测试用） */
  reset(): void {
    this.consecutiveFailures.clear();
    this.disabled.clear();
  }
}
