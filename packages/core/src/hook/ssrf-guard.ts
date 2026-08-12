/**
 * HTTP Hook SSRF 防护
 * 四层防御：IP 字面量验证、DNS 解析后验证、环境变量安全插值、CRLF 注入防护
 */

import { resolve4, resolve6 } from "node:dns/promises";

const BLOCKED_IPV4_RANGES = [
  { prefix: "0.", bits: 8 },
  { prefix: "10.", bits: 8 },
  { prefix: "100.64.", bits: 10 },
  { prefix: "127.", bits: 8 },
  { prefix: "169.254.", bits: 16 },
  { prefix: "172.16.", bits: 12 },
  { prefix: "172.17.", bits: 12 },
  { prefix: "172.18.", bits: 12 },
  { prefix: "172.19.", bits: 12 },
  { prefix: "172.20.", bits: 12 },
  { prefix: "172.21.", bits: 12 },
  { prefix: "172.22.", bits: 12 },
  { prefix: "172.23.", bits: 12 },
  { prefix: "172.24.", bits: 12 },
  { prefix: "172.25.", bits: 12 },
  { prefix: "172.26.", bits: 12 },
  { prefix: "172.27.", bits: 12 },
  { prefix: "172.28.", bits: 12 },
  { prefix: "172.29.", bits: 12 },
  { prefix: "172.30.", bits: 12 },
  { prefix: "172.31.", bits: 12 },
  { prefix: "192.168.", bits: 16 },
];

function isIPAddress(hostname: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) || hostname.includes(":");
}

/** IPv6 私有/本地/保留地址判定（归一化为小写、去除区域 id 与方括号后比较） */
function isBlockedIPv6(ip: string): boolean {
  let v = ip.toLowerCase().trim();
  // 去掉方括号 [::1] 与区域标识 fe80::1%eth0
  if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1);
  const pct = v.indexOf("%");
  if (pct >= 0) v = v.slice(0, pct);

  // 未指定地址 :: 与回环 ::1
  if (v === "::" || v === "::1") return true;
  // 链路本地 fe80::/10（fe80 - febf）
  if (/^fe[89ab][0-9a-f]:/.test(v)) return true;
  // 唯一本地地址 fc00::/7（fc.. / fd..）
  if (/^f[cd][0-9a-f][0-9a-f]:/.test(v)) return true;
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  // IPv6 映射地址 ::ffff:a.b.c.d → 按内嵌 IPv4 判定
  if (ip.toLowerCase().startsWith("::ffff:")) {
    return isBlockedAddress(ip.slice(7));
  }

  // IPv6 字面量
  if (ip.includes(":")) {
    return isBlockedIPv6(ip);
  }

  for (const range of BLOCKED_IPV4_RANGES) {
    if (ip.startsWith(range.prefix)) return true;
  }

  return false;
}

export function sanitizeHeaders(
  headers: Record<string, string>,
  allowedEnvVars?: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    let sanitized = value.replace(/\$(\w+)/g, (_, varName) => {
      if (allowedEnvVars?.includes(varName)) {
        return process.env[varName] ?? "";
      }
      return "";
    });
    // CRLF 注入防护
    sanitized = sanitized.replace(/[\r\n\0]/g, "");
    result[key] = sanitized;
  }
  return result;
}

/** DNS 错误码：表示「域名无对应记录」，此类失败放行无 SSRF 风险（后续 fetch 必然同样解析失败） */
const NO_RECORD_DNS_CODES = new Set(["ENOTFOUND", "ENODATA", "NOTFOUND"]);

export async function ssrfGuardedFetch(
  url: string,
  options: RequestInit & { allowedEnvVars?: string[] },
): Promise<Response> {
  const parsed = new URL(url);

  // Layer 1: IP 字面量直接验证
  if (isIPAddress(parsed.hostname) && isBlockedAddress(parsed.hostname)) {
    throw new Error(`SSRF 防护：${parsed.hostname} 是私有地址`);
  }

  // Layer 2: DNS 解析后验证（非 IP 字面量时）
  // ERRH-3 加固：
  //   1) 同时解析 A(IPv4) 与 AAAA(IPv6)，堵住「域名只有 AAAA 记录、A 记录解析抛错被吞→放行→
  //      fetch 命中 IPv6 私有地址」的真实绕过路径；
  //   2) 解析异常按类型 fail-close：仅当「域名确无记录」(ENOTFOUND/ENODATA) 时放行
  //      （fetch 必然同样解析失败，无 SSRF 风险），其余无法判定目标安全性的异常一律抛错拦截，
  //      不再静默 fail-open。
  if (!isIPAddress(parsed.hostname)) {
    const settled = await Promise.allSettled([
      resolve4(parsed.hostname),
      resolve6(parsed.hostname),
    ]);

    const resolvedIPs: string[] = [];
    let sawAnswer = false;
    let blockingError: Error | null = null;

    for (const r of settled) {
      if (r.status === "fulfilled") {
        sawAnswer = true;
        resolvedIPs.push(...r.value);
      } else {
        const code = (r.reason as any)?.code as string | undefined;
        // 「无此记录」不计为阻断性错误：该记录类型不存在不代表目标可疑
        if (!code || !NO_RECORD_DNS_CODES.has(code)) {
          blockingError =
            r.reason instanceof Error
              ? r.reason
              : new Error(String((r.reason as any)?.message ?? r.reason));
        }
      }
    }

    // 命中任一私有地址即拦截
    for (const ip of resolvedIPs) {
      if (ip && isBlockedAddress(ip)) {
        throw new Error(`SSRF 防护：${parsed.hostname} 解析到私有地址 ${ip}`);
      }
    }

    // 无任何成功解析、且存在「非无记录」类异常 → fail-close（无法确认目标安全，拒绝放行）
    if (!sawAnswer && blockingError) {
      throw new Error(
        `SSRF 防护：无法解析 ${parsed.hostname} 以验证目标地址安全性（${blockingError.message}），已拒绝请求`,
      );
    }
  }

  // Layer 3: 环境变量安全插值
  const { allowedEnvVars, headers: rawHeaders, ...fetchOptions } = options;
  const headers = rawHeaders
    ? sanitizeHeaders(rawHeaders as Record<string, string>, allowedEnvVars)
    : undefined;

  return fetch(url, { ...fetchOptions, headers });
}
