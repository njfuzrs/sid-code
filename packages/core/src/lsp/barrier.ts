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
 * 这两个数字只覆盖 tsls 5.1.3。其它无 version 的服务器若乱序处理通知，屏障判据会失效。
 *
 * ## 哪些服务器启用屏障（白名单，默认关闭）
 *
 * 「没跑过的服务器默认判 unverified」不是一句口号，是本文件用 `BARRIER_VERIFIED_COMMANDS`
 * 落地的策略：屏障判据依赖两个**未经一般性验证**的前提（通知按序处理、flush 窗口能排空
 * 旧推送），所以默认不启用。对未验证服务器，屏障可能造成两种伤害：
 * - 误丢新代际首推：若新内容推送恰好落在 flush 窗口内，而服务器又只在内容变化时推一次，
 *   该文件会**直到下次编辑都没有诊断**（不只是「晚一轮」，设计文档 §7 的说法偏乐观）；
 * - 乱序处理通知时漏判旧推送，等于白付窗口代价。
 *
 * 新增服务器前先按 `packages/core/tests/lsp/e2e/` 的探针重测时序，再把 command 加进
 * `BARRIER_VERIFIED_COMMANDS`；也可以在 lsp.json 里显式写 `"barrier": true` 覆盖（自担风险）。
 */

import { basename } from "path";
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

/**
 * 屏障被关闭后，每多少次 run 尝试一次「半开」恢复。
 *
 * 为什么需要：临时性失败（大工程冷启动 / 索引期，屏障请求连续 3s 超时）也会触发关闭，
 * 而原来的实现关闭后**永不重试**——一次冷启动就足以让整个会话退化为修复前行为。
 * 半开的意义是让「服务器缓过来了」能被发现，同时不为真正不支持的服务器白发请求。
 */
export const BARRIER_HALF_OPEN_INTERVAL = 20;

/** LSP 规范的 MethodNotFound 错误码（client.ts 把错误包成 `LSP error -32601: ...`） */
const METHOD_NOT_FOUND = "-32601";

/**
 * 已实测验证过屏障判据的服务器 command（按 basename 匹配，兼容绝对路径与自定义安装位置）。
 *
 * 新增条件：用 `packages/core/tests/lsp/e2e/` 的探针实测过「旧推送最晚在屏障后 Xms、
 * 新推送最早在屏障后 Yms」，且 flush 窗口落在两者之间。没测过就加进来 = 拿用户当实验品。
 */
export const BARRIER_VERIFIED_COMMANDS: ReadonlySet<string> = new Set([
  "typescript-language-server",
]);

/** 该 command 对应的服务器是否已验证过屏障判据 */
export function isBarrierVerifiedServer(command: string): boolean {
  try {
    return BARRIER_VERIFIED_COMMANDS.has(basename(command));
  } catch {
    return false; // 空串/畸形 command：保守判未验证
  }
}

/** 判断屏障失败是否属于「方法不存在」——这类失败重试没有意义 */
function isMethodNotFound(err: unknown): boolean {
  const msg = (err as { message?: string } | undefined)?.message ?? "";
  return msg.includes(METHOD_NOT_FOUND) || /method\s+not\s+found/i.test(msg);
}

export interface BarrierGateOptions {
  timeoutMs?: number;
  flushMs?: number;
  maxConsecutiveFailures?: number;
  halfOpenInterval?: number;
}

export class BarrierGate {
  private readonly timeoutMs: number;
  private readonly flushMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly halfOpenInterval: number;
  /** serverName → 连续失败次数（成功即清零） */
  private consecutiveFailures = new Map<string, number>();
  /** 已关闭屏障的服务器（MethodNotFound 后永久关闭；连续失败则等待半开试探） */
  private disabled = new Set<string>();
  /** 已关闭后跳过的 run 次数（半开恢复的计数器） */
  private skippedAfterDisable = new Map<string, number>();

  constructor(opts: BarrierGateOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? BARRIER_TIMEOUT_MS;
    this.flushMs = opts.flushMs ?? BARRIER_FLUSH_MS;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? BARRIER_MAX_CONSECUTIVE_FAILURES;
    this.halfOpenInterval = opts.halfOpenInterval ?? BARRIER_HALF_OPEN_INTERVAL;
  }

  /** 屏障请求超时（毫秒）。调用方发请求时传给 sendRequest */
  get timeout(): number {
    return this.timeoutMs;
  }

  /** 该服务器的屏障是否已被关闭（连续失败超限 / 方法不存在） */
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
    if (this.disabled.has(serverName)) {
      // 半开：每 halfOpenInterval 次放一次真请求试探。成功即恢复，失败则重新计数。
      // 这是为了区分「方法不存在」（第一次就永久禁用）与「冷启动/索引期临时超时」——
      // 后者原先会永久降级整个会话，服务器缓过来也回不去。
      const skipped = (this.skippedAfterDisable.get(serverName) ?? 0) + 1;
      if (skipped < this.halfOpenInterval) {
        this.skippedAfterDisable.set(serverName, skipped);
        return false;
      }
      this.skippedAfterDisable.delete(serverName);
    }

    try {
      await send();
    } catch (err) {
      const message = (err as Error)?.message;
      if (isMethodNotFound(err)) {
        // 方法不存在：不是抖动，重试没有意义，本 manager 生命周期内永久禁用
        this.disabled.add(serverName);
        this.skippedAfterDisable.delete(serverName);
        getLogger().debug(
          "LSP",
          `[${serverName}] 不支持屏障请求（Method not found），已关闭该服务器的诊断屏障（推送降级为 unverified）: ${message}`,
        );
        return false;
      }
      const n = (this.consecutiveFailures.get(serverName) ?? 0) + 1;
      this.consecutiveFailures.set(serverName, n);
      if (n >= this.maxConsecutiveFailures) {
        this.disabled.add(serverName);
        this.skippedAfterDisable.delete(serverName);
        getLogger().debug(
          "LSP",
          `[${serverName}] 屏障连续失败 ${n} 次，暂停该服务器的诊断屏障（每 ${this.halfOpenInterval} 次编辑半开重试一次，推送降级为 unverified）: ${message}`,
        );
      }
      return false;
    }

    // 成功：清零连续失败并解除禁用（半开试探成功即恢复）
    this.consecutiveFailures.delete(serverName);
    this.disabled.delete(serverName);
    this.skippedAfterDisable.delete(serverName);
    if (this.flushMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.flushMs));
    }
    return true;
  }
}
