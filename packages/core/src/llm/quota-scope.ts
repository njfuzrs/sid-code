/**
 * 账户级额度状态的**作用域标识**（2026-11-04 F2 ⑥）。
 *
 * ── 为什么不能按模型记 ──
 *
 * 额度是**账户级**资源：同一个端点 + 同一份凭据下，所有模型共用一份余额。
 * 按模型记会让「gpt-6.1-sol 额度耗尽」在下一个模型上重新撞一遍 —— 本会话 4 条循环
 * 各白试 3 次正是这个形态。`fallback.ts:358-360` 已记过同型教训
 * （把凭据过期误归因到模型）。
 *
 * ── 为什么是 (端点, 凭据指纹) ──
 *
 * - **端点**决定是哪家网关的哪份账户：同一个 baseURL 才是同一个账户；
 * - **凭据指纹**决定是哪个人/哪份 key：换 key 就该重新探测（充值后常常换 key）。
 * 两者都不含明文：`credential` 是 sha256 前 16 个十六进制字符，不可逆，
 * 只用于内存 Map 的 key，不落盘、不进日志/遥测。
 *
 * ⚠️ 指纹的用途是**区分**，不是安全认证。它不出现在任何对外输出里，
 * 也不参与任何权限判断 —— 真要防暴力反推，密钥本身的高熵才是防线。
 */

import { createHash } from "node:crypto";
import { normalizeBaseURL } from "./endpoint-key.ts";

/**
 * 额度状态的账户级作用域。
 *
 * 未实现 `Provider.quotaScope()` 的 provider 不参与跨循环共享（fail-open）：
 * 拿不到可靠的账户标识时，宁可各自撞一次，也不要把两个账户的额度混成一个。
 */
export interface QuotaScope {
  /** 归一化后的端点（`normalizeBaseURL`；空串 = 官方默认端点） */
  endpoint: string;
  /** 凭据指纹（sha256 前 16 位十六进制，不可逆） */
  credential: string;
}

/**
 * 凭据 → 稳定指纹。
 *
 * 为什么必须哈希而不是直接存 apiKey：这份 scope 会进内存 Map 的 key，
 * 一旦哪天有人把 Map dump 进日志/诊断包，明文 key 就跟着泄漏了。
 * 哈希后即使泄漏也只是「某个账户的指纹」，拿不到 key 本身。
 *
 * 空凭据返回 `""`（官方端点 + 无 key 的合法组合，例如本地 ollama 网关）。
 */
export function credentialFingerprint(secret: string | undefined): string {
  const s = (secret ?? "").trim();
  if (!s) return "";
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** 组装作用域。端点走 `normalizeBaseURL`，让「末尾斜杠 / host 大小写」不产生两个 key。 */
export function makeQuotaScope(
  baseURL: string | undefined,
  secret: string | undefined,
): QuotaScope {
  return {
    endpoint: normalizeBaseURL(baseURL),
    credential: credentialFingerprint(secret),
  };
}

/** Map 的 key：两个维度用 `|` 拼接。空值也占位，避免 `("", "abc")` 与 `("abc", "")` 撞车。 */
export function quotaScopeKey(scope: QuotaScope): string {
  return `${scope.endpoint}|${scope.credential}`;
}
