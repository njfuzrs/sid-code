/**
 * 用量账本远程 upsert 出口（M5 PR-5.1）。
 *
 * 挂在 `upsertUsageLedger` 写盘成功之后 fire-and-forget。本地 jsonl 仍是事实源；
 * 远程发不出去不阻断主流程（fail-open）。
 *
 * ## 为什么不复用 events 的 HttpExporter（R2）
 *
 * HttpExporter 的 body 是 `{events:[...]}`，失败盘按条 append。账本是 latest-wins
 * 一行：重放 30 个历史快照会让云端 `used_usd` 中间态跳动，重放旧快照会把云端
 * **回退**到更早的累计值。所以失败盘按 sessionId 覆盖写，不是 append。
 *
 * ## 稳定不发必须 throw（R3 / M4 T2 同款）
 *
 * 无凭据 / 明文非本地 / 401 若 `return`，重放路径会把「没发出去」当成成功。
 * 本模块没有 events 那种「resolve 即 unlink」的 disk-cache，但错误类型仍按
 * throw 语义分：401 / Skip 不写失败盘、不退避；5xx / 网络才覆盖写失败盘。
 *
 * ## 失败盘不 24h 过期（与 events 有意不同）
 *
 * events 丢一条是计数 -1；账本丢一行是这个会话的成本在云端永久 $0，对账出口
 * 直接假。宁肯堆着，直到凭据修好再发。凭据不会自己变好，所以 401 / Skip 也不
 * 删已有文件（T2：过期凭据堆着直到人修）。
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { applyDeviceAuth } from "../identity/credential.ts";
import { isNonLocalHttp } from "../config/policy.ts";
import { sidPaths } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";
import { QuadraticBackoff } from "../analytics/backoff.ts";
import { isEssentialTrafficOnly, isTelemetryDisabled } from "../analytics/privacy-level.ts";
import type { UsageLedgerEntry } from "./usage-ledger.ts";

/** 单次 POST 超时。账本一行远小于 2KiB，5s 足够；与 HttpExporter 同档。 */
export const USAGE_LEDGER_REMOTE_TIMEOUT_MS = 5_000;

/** 单请求 body 上限（契约 §7）。超了重试也不会变小，不写失败盘。 */
export const USAGE_LEDGER_REMOTE_MAX_BODY_BYTES = 16 * 1024;

export class SkipRemoteExportError extends Error {
  constructor(readonly reason: "no_auth" | "plaintext_http") {
    super(reason);
    this.name = "SkipRemoteExportError";
  }
}

export class UnauthorizedExportError extends Error {
  constructor() {
    super("401");
    this.name = "UnauthorizedExportError";
  }
}

/** body 超上限：重试不会变小，不写盘。 */
export class PayloadTooLargeExportError extends Error {
  constructor(readonly bytes: number) {
    super(`413 body ${bytes} > ${USAGE_LEDGER_REMOTE_MAX_BODY_BYTES}`);
    this.name = "PayloadTooLargeExportError";
  }
}

export interface FailedUsageLedgerRow {
  sessionId: string;
  payload: UsageLedgerEntry;
  failedAt: number;
}

let warnedSkipNoAuth = false;
let warnedSkipPlaintext = false;
let warnedUnauthorized = false;
let warnedTooLarge = false;
let warnedPrivacy = false;

let backoff: QuadraticBackoff | null = null;
let recovering = false;
let recoverStarted = false;

type UsagePushedListener = (entry: UsageLedgerEntry) => void;
const pushedListeners = new Set<UsagePushedListener>();

/**
 * 远程 upsert **成功**后的钩子。5.2 的预算刷新挂这里：失败的 upsert 不配刷新 used，
 * 避免用脏窗口去硬停。5.1 自己不调用预算。
 */
export function onUsageLedgerRemotePushed(listener: UsagePushedListener): () => void {
  pushedListeners.add(listener);
  return () => {
    pushedListeners.delete(listener);
  };
}

function notifyPushed(entry: UsageLedgerEntry): void {
  for (const listener of pushedListeners) {
    try {
      listener(entry);
    } catch {
      /* 监听方自己吞；出口不能被下游拖死 */
    }
  }
}

export function failedUsageLedgerPath(): string {
  const override = process.env.SID_CODE_FAILED_USAGE_LEDGER;
  if (override && override.trim() !== "") return override;
  return sidPaths.failedUsageLedger();
}

function usageEndpoint(): string | undefined {
  const raw = process.env.SID_CODE_USAGE_ENDPOINT;
  if (!raw || raw.trim() === "") return undefined;
  return raw.trim();
}

function readFailedRows(): FailedUsageLedgerRow[] {
  try {
    const path = failedUsageLedgerPath();
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf-8");
    const rows: FailedUsageLedgerRow[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as FailedUsageLedgerRow;
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof parsed.sessionId === "string" &&
          parsed.payload &&
          typeof parsed.payload === "object"
        ) {
          rows.push(parsed);
        }
      } catch {
        /* 跳过损坏行 */
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function writeFailedRows(rows: FailedUsageLedgerRow[]): void {
  const path = failedUsageLedgerPath();
  const dir = dirname(path);
  if (rows.length === 0) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* ignore */
    }
    return;
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
}

/**
 * 按 sessionId 覆盖写失败盘。同 sessionId 只留最新 payload。
 * live 这一拍的 Skip / 401 不走这里。
 */
export function upsertFailedUsageLedger(entry: UsageLedgerEntry): void {
  try {
    const existing = readFailedRows().filter((r) => r.sessionId !== entry.sessionId);
    existing.push({
      sessionId: entry.sessionId,
      payload: entry,
      failedAt: Date.now(),
    });
    writeFailedRows(existing);
  } catch {
    /* 失败盘自己也 fail-open */
  }
}

export function readFailedUsageLedger(): FailedUsageLedgerRow[] {
  return readFailedRows();
}

function removeFailedSession(sessionId: string): void {
  try {
    const remaining = readFailedRows().filter((r) => r.sessionId !== sessionId);
    writeFailedRows(remaining);
  } catch {
    /* ignore */
  }
}

function warnOnce(
  kind: "no_auth" | "plaintext" | "401" | "too_large" | "privacy",
  message: string,
): void {
  const log = getLogger();
  if (kind === "no_auth") {
    if (warnedSkipNoAuth) return;
    warnedSkipNoAuth = true;
  } else if (kind === "plaintext") {
    if (warnedSkipPlaintext) return;
    warnedSkipPlaintext = true;
  } else if (kind === "401") {
    if (warnedUnauthorized) return;
    warnedUnauthorized = true;
  } else if (kind === "too_large") {
    if (warnedTooLarge) return;
    warnedTooLarge = true;
  } else {
    if (warnedPrivacy) return;
    warnedPrivacy = true;
  }
  log.warn("TELEMETRY", message);
}

async function sendUsageLedger(entry: UsageLedgerEntry): Promise<"skipped" | "sent"> {
  if (isTelemetryDisabled() || isEssentialTrafficOnly()) {
    warnOnce("privacy", "隐私级别禁止非必要外发，跳过账本远程上报（本地 jsonl 仍 upsert）");
    return "skipped";
  }

  const endpoint = usageEndpoint();
  if (!endpoint) return "skipped";
  if (isNonLocalHttp(endpoint)) {
    warnOnce(
      "plaintext",
      `SID_CODE_USAGE_ENDPOINT 拒绝明文非本地地址（只允许 https:// 或 http://127.0.0.1|localhost）: ${endpoint}`,
    );
    throw new SkipRemoteExportError("plaintext_http");
  }

  const headers = applyDeviceAuth({ "Content-Type": "application/json" });
  if (!headers.Authorization) {
    warnOnce("no_auth", "账本远程上报无可用设备凭据，不上报远程、本拍不写失败盘（已有失败盘保留）");
    throw new SkipRemoteExportError("no_auth");
  }

  const body = JSON.stringify(entry);
  const bytes = Buffer.byteLength(body, "utf-8");
  if (bytes > USAGE_LEDGER_REMOTE_MAX_BODY_BYTES) {
    warnOnce(
      "too_large",
      `账本远程上报 body ${bytes} 字节超过 ${USAGE_LEDGER_REMOTE_MAX_BODY_BYTES}，不写失败盘`,
    );
    throw new PayloadTooLargeExportError(bytes);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), USAGE_LEDGER_REMOTE_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (response.status === 401) {
      warnOnce("401", "账本远程上报 401：设备凭据无效或已吊销，本会话不再重试、不写失败盘");
      throw new UnauthorizedExportError();
    }
    if (response.status === 413) {
      warnOnce("too_large", "账本远程上报 413：body 超上限，不写失败盘");
      throw new PayloadTooLargeExportError(bytes);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
  return "sent";
}

function isStableSkip(err: unknown): boolean {
  return (
    err instanceof SkipRemoteExportError ||
    err instanceof UnauthorizedExportError ||
    err instanceof PayloadTooLargeExportError
  );
}

function scheduleReplay(): void {
  if (!backoff) backoff = new QuadraticBackoff();
  backoff.schedule(async () => {
    await replayFailedUsageLedger();
  });
}

/**
 * 重放失败盘：每个 sessionId 只发最新 payload。
 * 成功则删那一行；401 / Skip 留盘不删（凭据修好再发）；瞬时失败留盘并退避。
 */
export async function replayFailedUsageLedger(): Promise<void> {
  if (recovering) return;
  recovering = true;
  try {
    const rows = readFailedRows();
    if (rows.length === 0) {
      backoff?.reset();
      return;
    }
    let anyTransient = false;
    for (const row of rows) {
      try {
        const outcome = await sendUsageLedger(row.payload);
        if (outcome === "skipped") continue;
        removeFailedSession(row.sessionId);
        notifyPushed(row.payload);
      } catch (err) {
        if (isStableSkip(err)) {
          // 留盘。凭据 / 明文修好之前再发也没用。
          continue;
        }
        anyTransient = true;
      }
    }
    if (anyTransient) scheduleReplay();
    else backoff?.reset();
  } finally {
    recovering = false;
  }
}

/**
 * 启动时扫一次失败盘。无 endpoint 则零操作（根本没配）。
 * 幂等：同进程只自动启动一次；测试可经 `__resetUsageLedgerRemoteForTest` 清。
 */
export function startUsageLedgerRemoteRecovery(): void {
  if (recoverStarted) return;
  recoverStarted = true;
  if (!usageEndpoint()) return;
  void replayFailedUsageLedger().catch(() => {});
}

/**
 * 写盘成功后的远程出口。调用方必须把它包在 catch 里：本函数会把瞬时失败写盘，
 * 但 Skip / 401 会 throw —— upsert 的调用方假设同步且不抛。
 */
export async function pushUsageLedgerRemote(entry: UsageLedgerEntry): Promise<void> {
  startUsageLedgerRemoteRecovery();
  try {
    const outcome = await sendUsageLedger(entry);
    if (outcome === "skipped") return;
    removeFailedSession(entry.sessionId);
    notifyPushed(entry);
    backoff?.reset();
  } catch (err) {
    if (isStableSkip(err)) return;
    upsertFailedUsageLedger(entry);
    scheduleReplay();
  }
}

/** 仅测试 */
export function __resetUsageLedgerRemoteForTest(): void {
  warnedSkipNoAuth = false;
  warnedSkipPlaintext = false;
  warnedUnauthorized = false;
  warnedTooLarge = false;
  warnedPrivacy = false;
  backoff?.reset();
  backoff = null;
  recovering = false;
  recoverStarted = false;
  pushedListeners.clear();
}
