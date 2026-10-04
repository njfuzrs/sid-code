/**
 * 企业通道状态：让「没配」看得见（U4）。
 *
 * 以前每条通道没配地址就直接 `return null`、零日志，`auth status` 却显示「✓ 凭据有效」——
 * 用户以为全通了，实际事件 / 账本 / 策略一条都没发。本模块给 `auth status` 和 `/doctor`
 * 逐条列出每条通道：地址从哪来、本地缓存说明上次发生了什么、（--verify 时）真实探测结果。
 *
 * 探测（`probe: true`）**都不写入数据**，也不需要后端加任何东西（agent-backend a5b3440 核对）：
 *
 * | 通道 | 请求 | 通过 |
 * | --- | --- | --- |
 * | 登录 / 策略 / 预算 | GET（带凭据） | 200 / 204 / 304 |
 * | flag | GET（无凭据，服务端豁免） | 200 |
 * | 事件 | POST {"events":[]}（带凭据） | 202：空数组全 0 计数，不写库 |
 * | 账本 | POST {}（带凭据） | **400**，见下 |
 * | 轨迹 | GET /health + 本地看 token 配没配 | 200（token 对不对探不出来，不发真实上传） |
 *
 * ⚠️ 账本「400 即通过」不是 bug，别修：服务端 `cost/router/ingest.py` 把 `require_device`
 * 写在函数签名上，FastAPI 先跑依赖再解析 body，所以凭据被拒一定是 401；能拿到 400
 * 说明凭据已被接受、只是 body 不合法——而不合法正是我们要的（不写库）。
 * 写入端点都**不支持 HEAD**，不要改成 HEAD 探测。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getSidHome, sidPaths } from "../config/paths.ts";
import { inspectBackendUrl, type BackendUrlInspection } from "./backend-url.ts";
import { backendUrl, resolveEndpoint, type BackendChannel } from "./endpoints.ts";
import { getDeviceCredential, getUsableCredentialToken } from "./credential.ts";
import { getLogger } from "../debug/logger.ts";

export type ChannelKey = "whoami" | "policy" | "budget" | "usage" | "events" | "flags" | "upload";

export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  whoami: "登录",
  policy: "策略",
  budget: "预算",
  usage: "账本",
  events: "事件",
  flags: "flag",
  upload: "轨迹",
};

const CHANNEL_ORDER: ChannelKey[] = [
  "whoami",
  "policy",
  "budget",
  "usage",
  "events",
  "flags",
  "upload",
];

export interface ChannelStatus {
  key: ChannelKey;
  label: string;
  /** 已解析出地址 */
  configured: boolean;
  /** 完整地址（未配置时为 null） */
  url: string | null;
  /** 来源：env / managed / user / legacy-env / legacy-settings / trace.upload.url */
  source: string | null;
  /** 本地可见的最近状态（缓存时间、待重放条数等），不发网络 */
  local?: string;
  /** 仅 probe：ok / fail / skipped */
  probe?: "ok" | "fail" | "skipped";
  /** 仅 probe：HTTP 状态码或错误摘要 + 判读 */
  probeDetail?: string;
}

export interface BackendChannelsReport {
  backend: BackendUrlInspection;
  channels: ChannelStatus[];
}

export interface CollectChannelsOptions {
  /** 发真实探测请求（auth status --verify） */
  probe?: boolean;
  /** trace.upload 的生效配置（url 已回落 backend.url）；不传当没配 */
  traceUpload?: { url?: string; token?: string } | null;
  /** analytics.featureFlagEndpoint 兼容项 */
  featureFlagEndpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function fmtTime(iso: string | undefined | number): string | undefined {
  if (iso === undefined) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const v = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function countLines(path: string): number {
  try {
    if (!existsSync(path)) return 0;
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

function localState(key: ChannelKey): string | undefined {
  if (key === "policy" || key === "budget") {
    const c = readJson(key === "policy" ? sidPaths.policyCache() : sidPaths.budgetCache());
    if (!c) return "尚未拉取过";
    const when = fmtTime(c.fetched_at as string | undefined);
    const st = typeof c.last_status === "number" ? c.last_status : undefined;
    const note =
      st === 204 ? (key === "policy" ? "204 无策略" : "204 无预算") : st ? String(st) : "";
    return `上次拉取 ${when ?? "?"}${note ? ` · ${note}` : ""}`;
  }
  if (key === "usage") {
    const override = process.env.SID_CODE_FAILED_USAGE_LEDGER?.trim();
    return `待重放 ${countLines(override || sidPaths.failedUsageLedger())} 条`;
  }
  if (key === "events") {
    try {
      const dir = sidPaths.telemetry();
      const n = existsSync(dir)
        ? readdirSync(dir).filter((f) => f.startsWith("failed_events") && f.endsWith(".jsonl"))
            .length
        : 0;
      return `磁盘缓存 ${n} 批`;
    } catch {
      return undefined;
    }
  }
  if (key === "flags") {
    const p = join(getSidHome(), "feature-flags-cache.json");
    try {
      return existsSync(p) ? `上次刷新 ${fmtTime(statSync(p).mtimeMs)}` : "尚未刷新过";
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 探测判读。返回 [ok, 说明]。 */
function judge(key: ChannelKey, status: number): [boolean, string] {
  const ok =
    key === "usage"
      ? status === 400 // 鉴权先于解析：400 = 凭据被接受（见文件头）
      : key === "events"
        ? status === 202
        : key === "flags" || key === "upload" || key === "whoami"
          ? status === 200
          : status === 200 || status === 204 || status === 304;
  if (ok) {
    if (key === "usage") return [true, "400（鉴权已通过，空 body 被拒，未写库）"];
    if (key === "events") return [true, "202（空批次，未写库）"];
    return [true, String(status)];
  }
  if (status === 401) return [false, "401 凭据失效或被吊销，请 sid-code auth login"];
  if (status === 404) return [false, "404 地址不存在，检查 backend.url 是否写错"];
  return [false, `HTTP ${status}`];
}

async function probeOne(
  ch: ChannelStatus,
  opts: CollectChannelsOptions,
  token: string | undefined,
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const needsAuth = ch.key !== "flags" && ch.key !== "upload";
  if (!ch.url) {
    ch.probe = "skipped";
    return;
  }
  if (needsAuth && !token) {
    ch.probe = "skipped";
    ch.probeDetail = "无设备凭据，未探测";
    return;
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (needsAuth) headers.Authorization = `Bearer ${token}`;
  let url = ch.url;
  let init: RequestInit = { method: "GET", headers };
  if (ch.key === "events" || ch.key === "usage") {
    headers["Content-Type"] = "application/json";
    init = { method: "POST", headers, body: ch.key === "events" ? '{"events":[]}' : "{}" };
  }
  if (ch.key === "upload") {
    // 上传端点用共享 token，真实上传会写库；只探健康检查
    url = backendUrl(ch.url, "health");
  }
  try {
    const resp = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    const [ok, detail] = judge(ch.key, resp.status);
    ch.probe = ok ? "ok" : "fail";
    ch.probeDetail = detail;
    if (ok && ch.key === "upload" && !opts.traceUpload?.token) {
      ch.probe = "fail";
      ch.probeDetail = "服务可达，但未配置 trace.upload.token";
    }
  } catch (err) {
    ch.probe = "fail";
    ch.probeDetail = `连接失败：${(err as Error).message}`;
  }
}

/**
 * 收集七条通道状态。不传 probe 时零网络请求。
 * 每条通道各自容错：任何一条出错不影响其他行。
 */
export async function collectBackendChannels(
  opts: CollectChannelsOptions = {},
): Promise<BackendChannelsReport> {
  const backend = inspectBackendUrl();
  const channels: ChannelStatus[] = CHANNEL_ORDER.map((key) => {
    const base: ChannelStatus = {
      key,
      label: CHANNEL_LABELS[key],
      configured: false,
      url: null,
      source: null,
    };
    if (key === "upload") {
      const url = opts.traceUpload?.url?.trim();
      if (url) {
        base.configured = true;
        base.url = url.replace(/\/+$/, "");
        base.source =
          backend.kind === "ok" && backend.backend.url === base.url
            ? backend.backend.source
            : "trace.upload.url";
      }
      base.local = opts.traceUpload?.token ? "token 已配置" : "token 未配置";
      return base;
    }
    const r = resolveEndpoint(key as BackendChannel, {
      legacySetting:
        key === "flags"
          ? { name: "analytics.featureFlagEndpoint", value: opts.featureFlagEndpoint }
          : undefined,
    });
    if (r) {
      base.configured = true;
      base.url = r.url;
      base.source = r.source;
    }
    base.local = localState(key);
    return base;
  });

  if (opts.probe) {
    const token = getUsableCredentialToken();
    await Promise.all(channels.map((c) => probeOne(c, opts, token)));
  }
  return { backend, channels };
}

/** `auth status` 与 `/doctor` 共用的文本渲染。 */
export function renderBackendChannels(report: BackendChannelsReport): string[] {
  const lines: string[] = [];
  const b = report.backend;
  if (b.kind === "ok") {
    lines.push(`企业通道（backend.url = ${b.backend.url}，来源 ${b.backend.source}）:`);
  } else if (b.kind === "invalid") {
    lines.push(`企业通道（backend.url 不合法，来源 ${b.source}：${b.raw}）:`);
  } else {
    lines.push("企业通道（未配置 backend.url）:");
  }
  lines.push("");
  const base = b.kind === "ok" ? b.backend.url : null;
  // 标签混了中文与 ASCII：按显示宽度（CJK 记 2）补齐，否则「flag」那行错位
  const width = (t: string) => [...t].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const pad = (t: string) => t + " ".repeat(Math.max(0, 4 - width(t)));
  for (const c of report.channels) {
    if (!c.configured) {
      lines.push(`  ${pad(c.label)}  ✗ 未配置 backend.url`);
      continue;
    }
    // 地址与 base 同源时只显示路径，不同源（兼容旧变量 / 独立部署的轨迹）显示全址 + 来源
    // 轨迹存的是 base 本身（上传器自己拼路径），显示它实际打到的上传路由
    const display = c.key === "upload" ? backendUrl(c.url!, "upload", "/session-file") : c.url!;
    const shown = base && display.startsWith(base) ? display.slice(base.length) : display;
    const src = c.source && base && c.url!.startsWith(base) ? "" : `（来源 ${c.source}）`;
    let mark = "✓";
    let tail = c.local ? `  ${c.local}` : "";
    if (c.probe === "fail") mark = "✗";
    if (c.probe === "ok" || c.probe === "fail")
      tail = `  ${c.probeDetail}${c.local ? ` · ${c.local}` : ""}`;
    if (c.probe === "skipped" && c.probeDetail) tail = `  ${c.probeDetail}`;
    lines.push(`  ${pad(c.label)}  ${mark} ${shown}${src}${tail}`);
  }
  return lines;
}

let warnedLoggedInNoBackend = false;

/**
 * 已登录（凭据绑到人）但 backend.url 解析不出来：这个组合不该出现，
 * 策略 / 预算 / 账本 / 事件 / flag 全部静默不发。进程内告警一次。返回是否告警了。
 */
export function warnIfLoggedInWithoutBackend(): boolean {
  if (warnedLoggedInNoBackend) return false;
  if (!getDeviceCredential()?.user) return false;
  if (inspectBackendUrl().kind === "ok") return false;
  warnedLoggedInNoBackend = true;
  getLogger().warn(
    "BACKEND",
    "已登录企业后端，但未配置有效的 backend.url：策略 / 预算 / 账本 / 事件 / flag 都不会发往后端。" +
      "运行 sid-code auth status 查看各通道状态",
  );
  return true;
}

export function __resetBackendChannelsForTest(): void {
  warnedLoggedInNoBackend = false;
}
