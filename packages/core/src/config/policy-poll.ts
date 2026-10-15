/**
 * 远程策略低频轮询（D7）。
 *
 * 此前远程策略只在启动和 /login 时拉取，管理员改完策略要等员工重启才生效。
 * 这里每 30 分钟（±10% 抖动）重拉一次，复用 reloadEnterprisePolicy 的整条权威 / 非权威判定：
 * - 请求带 If-None-Match，策略没变时服务端回 304，不传 body；
 * - 只有权威变更（outcome=applied 即 200、none 即 204）才回调 onChange，由调用方 apply 并刷新
 *   权限与 Hook 门控；
 * - 304（unchanged）不回调：进程内状态已经是这份策略，重新 apply 只会多发一条遥测；
 * - 非权威结果（cache_fallback / error：超时、5xx、401）**不回调，保留进程内现状**。
 *   这条不能放开：磁盘缓存只有 POLICY_CACHE_STALE_MS（10 分钟）寿命，而两轮相隔 30 分钟，
 *   某一轮碰上网络抖动时 loader 会判缓存过期、返回 null —— 照单 apply 就等于
 *   「网一抖，企业 deny 就被撤掉」。启动路径没有「现状」可保留，才需要那套过期规则；
 *   轮询时已有一份权威结果在进程里，它比一份过期缓存更可信。
 *
 * 为什么不是更短的间隔：策略是低频变更的管控数据，30 分钟的生效延迟对管理员可接受，
 * 而每个在线客户端每小时 2 次带 ETag 的请求对服务端几乎没有负担。预算走自己的 30 秒节流刷新，不在这里。
 *
 * 定时器 unref：不阻止无头模式进程退出。只在配了远程策略地址且有设备凭据时才发请求，
 * 未登录 / 未配后端时每轮只做两次本地判断，零网络。
 */

import { getLogger } from "../debug/logger.ts";
import { getUsableCredentialToken } from "../identity/credential.ts";
import { resolveEndpoint } from "../identity/endpoints.ts";
import { reloadEnterprisePolicy, type PolicyLoadResult } from "./policy.ts";

/** 轮询基准间隔：30 分钟。 */
export const POLICY_POLL_INTERVAL_MS = 30 * 60 * 1000;

/** 抖动比例：避免同一时刻启动的一批客户端一直同步打到服务端。 */
const POLICY_POLL_JITTER_RATIO = 0.1;

export interface PolicyPollOptions {
  /** 拿到非 304 的结果时回调。抛错只记日志，不会停掉轮询。 */
  onChange: (result: PolicyLoadResult) => void | Promise<void>;
  /** 仅测试覆盖：间隔与随机源。 */
  intervalMs?: number;
  random?: () => number;
  /** 仅测试覆盖：是否应当发请求（缺省 = 配了策略地址且有可用凭据）。 */
  shouldPoll?: () => boolean;
  /** 仅测试覆盖：加载函数（缺省 reloadEnterprisePolicy）。 */
  reload?: () => Promise<PolicyLoadResult>;
}

function defaultShouldPoll(): boolean {
  return !!resolveEndpoint("policy")?.url && !!getUsableCredentialToken();
}

/** 下一次触发的延迟：基准间隔 ±10%。 */
export function nextPolicyPollDelay(
  intervalMs: number,
  random: () => number = Math.random,
): number {
  const jitter = (random() * 2 - 1) * POLICY_POLL_JITTER_RATIO * intervalMs;
  return Math.max(1, Math.round(intervalMs + jitter));
}

/**
 * 启动轮询，返回停止函数。用 setTimeout 链而不是 setInterval：
 * 上一轮没结束（慢握手最长约 30 秒）时不会叠出第二个请求，每轮也能重新取抖动。
 */
export function startEnterprisePolicyPolling(opts: PolicyPollOptions): () => void {
  const log = getLogger();
  const intervalMs = opts.intervalMs ?? POLICY_POLL_INTERVAL_MS;
  const random = opts.random ?? Math.random;
  const shouldPoll = opts.shouldPoll ?? defaultShouldPoll;
  const reload = opts.reload ?? reloadEnterprisePolicy;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(tick, nextPolicyPollDelay(intervalMs, random));
    (timer as { unref?: () => void }).unref?.();
  };

  const tick = async () => {
    timer = null;
    if (stopped) return;
    try {
      if (shouldPoll()) {
        const result = await reload();
        if (!result.remoteAuthoritative) {
          log.debug("POLICY", `轮询：远程策略非权威（${result.meta.outcome}），保留进程内现状`);
        } else if (!stopped && result.meta.outcome !== "unchanged") {
          log.info("POLICY", `轮询：远程策略结果 ${result.meta.outcome}，重新应用`);
          await opts.onChange(result);
        }
      }
    } catch (err: any) {
      log.debug("POLICY", `轮询远程策略失败: ${err?.message ?? err}`);
    }
    schedule();
  };

  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
