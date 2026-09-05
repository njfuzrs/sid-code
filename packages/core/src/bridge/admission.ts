/**
 * Bridge 准入检查（D14 —— 十六条里唯一一条安全性质的）
 *
 * ## 为什么 `--bridge` 需要准入，而别的 CLI 参数不需要
 *
 * 这个参数一开，就意味着**接受一个远端 WebSocket 端点下发的指令，在本地执行
 * 文件读写和 shell 命令**。它的风险等级和别的参数不是一个量级：
 * 一条粘错的命令行、一个被改过的 shell 别名、一个恶意的 npm script，
 * 都能把本机变成一台听远端指挥的机器。
 *
 * 而权限体系在这条路径上**是自证的**：确认请求虽然会经 `PermissionProxy`
 * 转发出去等人批，但**批准者就是那个远端**。所以"有权限确认"在这里不构成防线，
 * 防线必须在**连接建立之前**、由**本机的人**给出。
 *
 * ## 刻意不照搬 CC 的九道检查
 *
 * CC 在这里有九道准入检查，其中**至少五道是它的运营需要**（服务端灰度、
 * 组织策略下发、强制版本下限、编译期 feature flag、组织 UUID 归档）——
 * sid-code 是自托管、URL 由用户自己给，这些门**本来就不适用**。
 * 照着 spec 逐条补齐是浪费。这里只做三件事：
 *
 *   1. **首次对某个 URL 使用时交互确认一次，记住这个 URL**（最低成本、效果最好）
 *   2. **非 `wss://` 的明文连接额外要求 `--bridge-insecure`**（凭据与指令全裸奔）
 *   3. **企业侧可用 policy 直接关掉这个能力**（fail-closed）
 *
 * ## 量化要求（写在代码里，因为它决定了这段代码有没有用）
 *
 * ⚠️ **加了防线之后要量触发率，不能只看"有没有事故"。**
 * 安全是"坏事没发生"，负面事件天然稀疏、分母恒 0、曲线恒平，
 * **分不清"防线起作用"和"运气好"**。本仓 `scripts/defense-trigger-rate.ts`
 * 实测出过 **0% 触发**（防线全在、调用全 0，防线自己成了死功能）。
 * 所以「加了防线」和「防线被触发过」必须当**两个事实**分别验证 ——
 * 每次判定都记一条 audit 事件，就是为了让后者可被复算。
 */

import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { sidPaths } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";

/** 准入判定结果 */
export type BridgeAdmissionResult =
  | { allowed: true; reason: "already-trusted" | "user-confirmed" | "policy-allowed" }
  | { allowed: false; reason: BridgeDenyReason; message: string };

export type BridgeDenyReason =
  | "policy-disabled" // 企业 policy 关掉了这个能力
  | "insecure-scheme" // 明文 ws:// 且没给 --bridge-insecure
  | "invalid-url" // URL 根本不合法
  | "user-declined" // 用户当面拒绝
  | "non-interactive"; // 没有 TTY 可问，fail-closed

/** 信任存储：URL → 首次确认时间戳 */
interface BridgeTrustStore {
  [url: string]: { confirmedAt: string };
}

export interface BridgeAdmissionOptions {
  /** 中继 URL */
  url: string;
  /** 用户显式接受明文连接（--bridge-insecure） */
  allowInsecure?: boolean;
  /** 企业 policy：false = 禁用 Bridge 能力 */
  policyEnabled?: boolean;
  /**
   * 交互确认回调。返回 true = 用户同意。
   * 为 undefined 表示**无法询问**（无 TTY / 非交互），此时一律拒绝（fail-closed）——
   * 这条路径不能"默认放行"：默认放行等于没有这道门。
   */
  confirm?: (prompt: string) => Promise<boolean>;
  /** 跳过持久化（测试用） */
  skipPersist?: boolean;
}

/** 规范化 URL 作为信任键：大小写、尾斜杠、以及**必须剥掉 query 里的 token** */
export function normalizeBridgeUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;

  // 剥掉整个 query/hash：认证 token 常挂在 query 上，把它写进磁盘上的信任文件
  // 等于**把凭据落盘**。信任的对象是"这个端点"，不是"这次带的 token"。
  parsed.search = "";
  parsed.hash = "";
  // 尾斜杠归一，避免 wss://a/ 与 wss://a 被当成两个端点各问一次
  if (parsed.pathname === "/") parsed.pathname = "";
  return parsed.toString().replace(/\/$/, "").toLowerCase();
}

async function loadStore(): Promise<BridgeTrustStore> {
  const file = sidPaths.trustedBridgeUrls();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(await readFile(file, "utf-8")) as BridgeTrustStore;
  } catch {
    // 文件损坏时按"没有信任记录"处理 —— 多问一次远比错误放行好
    return {};
  }
}

async function saveStore(store: BridgeTrustStore): Promise<void> {
  const file = sidPaths.trustedBridgeUrls();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(store, null, 2), "utf-8");
}

/** 这个 URL 之前确认过吗（供 /bridge status 之类的只读查询用） */
export async function isBridgeUrlTrusted(url: string): Promise<boolean> {
  const key = normalizeBridgeUrl(url);
  if (!key) return false;
  return Boolean((await loadStore())[key]);
}

/** 撤销对某个 URL 的信任（供用户改主意时用） */
export async function revokeBridgeUrl(url: string): Promise<boolean> {
  const key = normalizeBridgeUrl(url);
  if (!key) return false;
  const store = await loadStore();
  if (!store[key]) return false;
  delete store[key];
  await saveStore(store);
  return true;
}

/**
 * 准入判定。顺序刻意如此：**先看能不能用（policy），再看安全形态（scheme），
 * 最后才问人**。反过来会让用户在一个注定被 policy 拒掉的 URL 上白确认一次。
 */
export async function checkBridgeAdmission(
  options: BridgeAdmissionOptions,
): Promise<BridgeAdmissionResult> {
  const log = getLogger();

  // ① 企业 policy —— 显式 false 才算关闭（undefined = 未配置 = 不拦）
  if (options.policyEnabled === false) {
    log.warn("BRIDGE", "准入拒绝：企业 policy 已禁用 Bridge 远程控制能力");
    return {
      allowed: false,
      reason: "policy-disabled",
      message: "企业策略已禁用 Bridge 远程控制（settings 中 bridge.enabled = false）",
    };
  }

  // ② URL 合法性
  const key = normalizeBridgeUrl(options.url);
  if (!key) {
    return {
      allowed: false,
      reason: "invalid-url",
      message: `不是合法的 Bridge URL: ${options.url}（需要 ws:// 或 wss://）`,
    };
  }

  // ③ 明文连接 —— 这条链路上跑的是**认证 token 与远端指令**，
  // 明文意味着同网段任何人都能读到并伪造。要求显式 opt-in。
  if (key.startsWith("ws://") && !options.allowInsecure) {
    log.warn("BRIDGE", `准入拒绝：明文连接 ${options.url} 未显式允许`);
    return {
      allowed: false,
      reason: "insecure-scheme",
      message:
        `拒绝明文 Bridge 连接: ${options.url}\n` +
        `远端指令与认证 token 会以明文经过网络。改用 wss:// ，` +
        `或确认风险后显式加 --bridge-insecure。`,
    };
  }

  // ④ 已确认过的 URL 直接放行
  const store = await loadStore();
  if (store[key]) {
    log.debug("BRIDGE", `准入通过：${key} 此前已确认（${store[key]!.confirmedAt}）`);
    return { allowed: true, reason: "already-trusted" };
  }

  // ⑤ 首次使用 —— 必须问人。无法问 ⇒ 拒绝（fail-closed）。
  if (!options.confirm) {
    log.warn("BRIDGE", `准入拒绝：${key} 首次使用但当前无法交互确认`);
    return {
      allowed: false,
      reason: "non-interactive",
      message:
        `首次连接该 Bridge 端点需要确认，但当前环境无法交互:\n  ${options.url}\n` +
        `请在交互式终端里先运行一次以完成确认。`,
    };
  }

  const confirmed = await options.confirm(buildConfirmPrompt(options.url));
  if (!confirmed) {
    log.warn("BRIDGE", `准入拒绝：用户拒绝连接 ${key}`);
    return { allowed: false, reason: "user-declined", message: "已取消：用户拒绝该 Bridge 连接" };
  }

  if (!options.skipPersist) {
    store[key] = { confirmedAt: new Date().toISOString() };
    await saveStore(store).catch((err) => {
      // 记不住不该阻断本次连接，但要说清楚"下次还会再问"
      log.warn("BRIDGE", `信任记录写入失败（下次仍会询问）: ${err.message}`);
    });
  }

  log.info("BRIDGE", `准入通过：用户确认了 ${key}`);
  return { allowed: true, reason: "user-confirmed" };
}

/**
 * 确认提示文案。
 *
 * 刻意把**能力**说清楚而不是只问"是否连接" —— 用户要判断的是
 * "我是否愿意让这个端点在我的机器上跑命令"，不是"要不要建个 WebSocket"。
 * 也刻意点明权限确认在这条路径上是自证的，否则用户会以为还有下一道门。
 */
export function buildConfirmPrompt(url: string): string {
  return [
    `即将启用 Bridge 远程控制：`,
    `  ${url}`,
    ``,
    `这意味着该端点可以向本机下发指令，包括读写文件和执行 shell 命令。`,
    `⚠️ 工具权限确认会被转发到该远端 —— 也就是说，批准者就是它自己。`,
    ``,
    `确认后会记住这个地址，下次不再询问。`,
  ].join("\n");
}
