/**
 * HTTP Hook SSRF 防护
 * 四层防御：IP 字面量验证、DNS 解析后验证、环境变量安全插值、CRLF 注入防护
 */

import { resolve as dnsResolve } from "node:dns/promises";

const BLOCKED_IPV4_RANGES = [
  { prefix: "0.", bits: 8 },
  { prefix: "10.", bits: 8 },
  { prefix: "100.64.", bits: 10 },
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
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    hostname.includes(":");
}

export function isBlockedAddress(ip: string): boolean {
  // IPv6 映射地址
  if (ip.startsWith("::ffff:")) {
    return isBlockedAddress(ip.slice(7));
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
  if (!isIPAddress(parsed.hostname)) {
    try {
      const addresses = await dnsResolve(parsed.hostname);
      for (const addr of addresses) {
        const ip = typeof addr === "string" ? addr : (addr as any).address;
        if (ip && isBlockedAddress(ip)) {
          throw new Error(`SSRF 防护：${parsed.hostname} 解析到私有地址 ${ip}`);
        }
      }
    } catch (err: any) {
      if (err.message?.startsWith("SSRF")) throw err;
    }
  }

  // Layer 3: 环境变量安全插值
  const { allowedEnvVars, headers: rawHeaders, ...fetchOptions } = options;
  const headers = rawHeaders
    ? sanitizeHeaders(rawHeaders as Record<string, string>, allowedEnvVars)
    : undefined;

  return fetch(url, { ...fetchOptions, headers });
}
