/**
 * MCP 管理器
 * 管理多个 MCP 服务器连接，收集所有可用工具
 * 支持：联合类型状态机、工具过滤、Resources/Prompts、差异化重连、健康检查
 * 并发控制：本地/远程分流、pMap 动态调度
 * 工具桥接：annotations 映射、描述截断、大结果处理
 */

import type { MCPServerConfig } from "../config/config.ts";
import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "../tool/types.ts";
import type { MCPToolDefinition, MCPResource, MCPPrompt, McpPolicy } from "./types.ts";
import { isMcpServerAllowed } from "./policy.ts";
import { MCPConnectionStatus } from "./types.ts";
import { MCPClient } from "./client.ts";
import {
  StdioTransport,
  HTTPTransport,
  StreamableHTTPTransport,
  SSETransport,
  WebSocketTransport,
} from "./transport.ts";
import { buildMcpToolName } from "./normalization.ts";
import { logToolInvoked } from "../analytics/events.ts";
import { mcpPluginOrigin } from "../analytics/plugin-attribution.ts";
import { expandConfigEnvVars } from "./env-expansion.ts";
import { buildSidBackendHeaders, SID_BACKEND_AUTH } from "./backend-auth.ts";
import { enforceMcpOutputTokenLimit, IMAGE_TOKEN_ESTIMATE } from "./mcp-output-limit.ts";
import { getMcpTimeout, getMcpToolTimeout } from "./mcp-timeout.ts";
import { getRetryAfterMs } from "./transport.ts";
import { computeBackoffMs } from "../config/network-profile.ts";
import { getLogger } from "../debug/logger.ts";
import { join } from "path";
import { ensureSidTempDir } from "@sid-code/shared/utils/temp-dir.ts";
import {
  isOAuthEnabled,
  getValidAccessToken,
  performOAuthFlow,
  NeedsAuthorizationError,
  redactOAuthUrl,
} from "./oauth.ts";

/** 重连配置 */
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 1000; // ms
/**
 * 重连退避上限（D27）。原公式 base × 2^(n-1) 没有 cap：MAX=5 时最大 16s 尚可，
 * 但常量一旦调大就失控（MAX=10 → 第 10 次 512s）。与 client.ts 的请求重试同用
 * computeBackoffMs、同一个 30s 上限。
 */
const RECONNECT_MAX_DELAY = 30_000; // ms
/**
 * 熔断 half-open 探测间隔（D23）：耗尽重连次数进入 FAILED 后，按此周期再试探一次，
 * 成功即回 CONNECTED 并清零计数。没有这一步，一次 ~31s 的网络中断就会让 server
 * 在会话余生里永久不可用。
 */
const HALF_OPEN_PROBE_INTERVAL = 60_000; // ms
/** 健康检查间隔 */
const HEARTBEAT_INTERVAL = 30_000; // ms
/** 工具描述截断上限 */
const MAX_MCP_DESCRIPTION_LENGTH = 2048;
/** 工具结果大小上限 */
const MAX_RESULT_SIZE = 100_000;
/** 本地 stdio 并发上限 */
const LOCAL_BATCH_SIZE = 3;
/** 远程连接并发上限 */
const REMOTE_BATCH_SIZE = 20;
/**
 * Server instructions 截断上限——**唯一**一道 instructions 长度防线（D29）。
 *
 * 单个 server 的 instructions 可能几千字（如 MasterGo DSL 工作流），全量注入既吃 token 又
 * 增加模型元认知外泄概率（2026-07-30 轨迹 20260730-135709 实测 glm-5.2 把注入内容"说"了出来）。
 * 注入点 `query/loop.ts` 原先还有一道 4000 的二次截断，但 block 最长 = 2048 + 截断标记 +
 * `## <server>\n`，要 server 名超过 1900 字才会触发——是死代码，且会让人以为「这里放宽了，
 * loop 那边还有一道兜着」。已删除，要调上限只改这里。
 */
export const MAX_INSTRUCTIONS_LENGTH = 2048;

/** 服务器状态信息 */
export interface MCPServerStatusInfo {
  name: string;
  status: MCPConnectionStatus;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  transport: string;
  error?: string;
  reconnectAttempts?: number;
  instructions?: string;
}

/** 向后兼容 */
export type MCPServerStatus = MCPServerStatusInfo;

/** 单个服务器的运行时状态 */
interface ServerState {
  status: MCPConnectionStatus;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  error?: string;
  reconnectAttempts: number;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  /** half-open 探测定时器（D23，FAILED 后周期性试探恢复） */
  probeTimer?: ReturnType<typeof setTimeout>;
  resources: MCPResource[];
  prompts: MCPPrompt[];
  instructions?: string;
}

/** MCP 工具适配器 - 将 MCP 工具适配为内部 Tool 接口 */
class MCPToolAdapter implements Tool {
  private client: MCPClient;
  private def: MCPToolDefinition;
  private serverName: string;
  /** 整个工具调用的总超时（D14，含全部重试），由 getMcpToolTimeout 决定 */
  private toolTimeoutMs: number;

  constructor(
    client: MCPClient,
    def: MCPToolDefinition,
    serverName: string,
    toolTimeoutMs: number,
  ) {
    this.client = client;
    this.def = def;
    this.serverName = serverName;
    this.toolTimeoutMs = toolTimeoutMs;
  }

  name(): string {
    return buildMcpToolName(this.serverName, this.def.name);
  }

  description(): string {
    const desc = this.def.description ?? "";
    if (desc.length > MAX_MCP_DESCRIPTION_LENGTH) {
      return desc.slice(0, MAX_MCP_DESCRIPTION_LENGTH) + "… [截断]";
    }
    return desc;
  }

  inputSchema(): Record<string, unknown> {
    return this.def.inputSchema;
  }

  readOnly(): boolean {
    return this.def.annotations?.readOnlyHint ?? false;
  }

  isConcurrencySafe(): boolean {
    return this.def.annotations?.readOnlyHint ?? false;
  }

  /**
   * D16：Server 声明 `destructiveHint: true` → 权限层把它的确认当安全类确认，
   * yesMode / auto 分类器 / hook allow 都不能静默放行（见 permission/checker.ts Step 14）。
   * 缺省 false 与协议默认值（未声明 = 可能有破坏性）方向相反，但这里只做**收紧**：
   * 没声明的工具照旧走默认 ask，不因缺省值被放宽。
   */
  isDestructive(): boolean {
    return this.def.annotations?.destructiveHint === true;
  }

  /** D16：Server 声明的「会与外部世界交互」，透传给权限确认文案 */
  isOpenWorld(): boolean {
    return this.def.annotations?.openWorldHint === true;
  }

  /** D15 / D16：只有 Server 显式声明幂等的工具才允许在「可能已执行」的错误上重试 */
  isIdempotent(): boolean {
    return this.def.annotations?.idempotentHint === true;
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    // 漏斗 10 · 插件：市场插件按调用计数。发点放在适配器自身而非各执行器 ——
    // 主循环 / 进程内子代理 / spawn 子代理 / forked agent 最终都走这里，单一汇聚点不会漏计也不会重计。
    // 用的是**原始** serverName（配置 key `plugin:<plugin>:<server>`）与原始 def.name，
    // 不从 buildMcpToolName 规范化后的 `mcp__...` 反推（`:`→`_` + 长度截断，有歧义）。
    // 是否真发由市场注册表决定，用户自配 MCP / 本地插件查不到即不发。
    logToolInvoked(this.name(), mcpPluginOrigin(this.serverName, this.def.name));
    try {
      const result = await this.callWithToolTimeout(input as Record<string, unknown>, signal);

      let text = result.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n");

      // G3：图片内容不静默丢弃。当前主循环 MCP 结果走文本通道，无法透传 image block，
      // 故按固定 token/张计入预算并给占位说明（对齐 CC IMAGE_TOKEN_ESTIMATE 语义）。
      const imageCount = result.content.filter(
        (c) => c.type === "image" && (c.data || c.mimeType),
      ).length;
      if (imageCount > 0) {
        const placeholder = `[MCP 结果含 ${imageCount} 张图片，约 ${imageCount * IMAGE_TOKEN_ESTIMATE} token，当前通道不透传图片内容]`;
        text = text ? `${text}\n\n${placeholder}` : placeholder;
      }

      // G3：先按 token 上限截断喂给模型的部分（默认 25000 token，env 可覆盖）。
      // 截断与「结果过大落盘」分层：落盘存完整存档，截断控喂模型的量，两者可同时发生。
      const { text: limitedText, truncated } = enforceMcpOutputTokenLimit(text);

      // 字符级落盘保护：完整文本过大时落盘完整结果，返回截断/预览 + 路径。
      if (text.length > MAX_RESULT_SIZE) {
        const tmpPath = join(ensureSidTempDir(), `mcp-result-${Date.now()}.txt`);
        await Bun.write(tmpPath, text);
        const preview = truncated ? limitedText : text.slice(0, 2000);
        return {
          output: `结果过大 (${text.length} 字符)，完整结果已保存到: ${tmpPath}\n\n预览:\n${preview}`,
          isError: false,
        };
      }

      return {
        output: limitedText || "(无输出)",
        isError: result.isError,
      };
    } catch (err: any) {
      return {
        output: `MCP 工具调用失败: ${err.message}`,
        isError: true,
      };
    }
  }

  /**
   * D14：工具调用的外层总超时。必须**包住重试**——每次请求的 transport 超时（getMcpTimeout，30s）
   * 是内层；没有这一层时一次 tools/call 的真实上限是「30s × 重试次数 + 退避」的涌现值，
   * `SID_CODE_MCP_TOOL_TIMEOUT` 写进了官网却没有读取者。超时后 abort 内层请求，不留孤儿。
   */
  private async callWithToolTimeout(args: Record<string, unknown>, signal?: AbortSignal) {
    const ctl = new AbortController();
    const onOuterAbort = () => ctl.abort();
    if (signal) {
      if (signal.aborted) ctl.abort();
      else signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.client.callTool(this.def.name, args, ctl.signal, { idempotent: this.isIdempotent() }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            ctl.abort();
            reject(new Error(`工具调用超时 (${this.toolTimeoutMs}ms)`));
          }, this.toolTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}

/** 工具过滤：根据 includeTools/excludeTools 配置过滤工具列表 */
function filterTools(tools: MCPToolDefinition[], config: MCPServerConfig): MCPToolDefinition[] {
  if (config.includeTools?.length) {
    return tools.filter((t) => config.includeTools!.includes(t.name));
  }
  if (config.excludeTools?.length) {
    return tools.filter((t) => !config.excludeTools!.includes(t.name));
  }
  return tools;
}

/**
 * 简易 pMap：并发控制的 Promise.all，结果按输入顺序写回（工具顺序稳定，见 R5）。
 *
 * D27：单项抛错不会拖垮整批。旧实现里 fn 一抛，该 worker 放弃它后面的全部项、
 * Promise.all 立即 reject、其它 worker 已完成的结果全部丢失——「10 个 server 里 1 个抛错，
 * 另外 9 个的连接结果全丢」。现在每项的异常交给 onError 换成兜底值，其余项照常完成。
 *
 * @internal 导出仅供测试
 */
export async function pMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
  onError: (item: T, err: unknown) => R,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        results[i] = onError(items[i], err);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** 截断 instructions */
function truncateInstructions(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.length > MAX_INSTRUCTIONS_LENGTH) {
    return raw.slice(0, MAX_INSTRUCTIONS_LENGTH) + "… [截断]";
  }
  return raw;
}

export class MCPManager {
  private clients = new Map<string, MCPClient>();
  private serverConfigs = new Map<string, MCPServerConfig>();
  /**
   * D21：enabled:false 的 server。单独存放而不进 serverConfigs——后者是「受管连接」集合，
   * 重连 / 探测 / listOAuthServers / closeAll 都遍历它，混进去就得在每处补一个跳过判断。
   * 这里只服务于 getStatus 的展示。
   */
  private disabledConfigs = new Map<string, MCPServerConfig>();
  private serverStates = new Map<string, ServerState>();
  /** 工具变更时的回调（供外部刷新工具列表） */
  onToolsRefresh?: (serverName: string, tools: Tool[]) => void;
  /**
   * prompt 集合 / 连接状态变更时的回调（P1-2，供外部刷新斜杠命令补全列表）。
   *
   * 为什么必须由 manager 广播而不是 UI 在调用处自己刷：连接状态变化有一部分
   * **没有任何 UI 调用点**——心跳失败后的自动重连、子进程退出、指数退避成功，
   * 都发生在 manager 内部。让消费方"记得在每个入口刷一次"结构上覆盖不到这些。
   *
   * MCP prompt 会被投影成 `mcp__<server>__<prompt>` 斜杠命令（见 mcp-prompt-commands.ts），
   * 所以 prompt 集合变了等于可用命令变了。
   */
  onPromptsChanged?: () => void;
  /**
   * OAuth 需要用户授权时的回调（供 UI 展示授权 URL / 打开浏览器）。
   * 返回的 Promise 由实现方决定何时 resolve（通常立即 resolve，授权在后台完成）。
   * 未设置时，OAuth 流程会把 URL 写入日志，用户需手动打开。
   */
  onOAuthAuthorizationUrl?: (serverName: string, url: string) => void;
  /**
   * G3 接线：Elicitation 处理器。MCP 服务器向客户端请求额外信息（表单/OAuth URL）时调用。
   * 由 App 层注入（路由到 cliElicitationHandler / DialogManager）；
   * 未设置时服务器 elicitation 请求全部被 cancel（defaultElicitationHandler）。
   */
  elicitationHandler?: import("./elicitation.ts").ElicitationHandler;
  /**
   * HC24：Elicitation / ElicitationResult hook 的发射端。由 App 层注入 hookSystem；
   * 不直接持有 HookSystem 类型，避免 mcp → hook 的反向依赖。fire-and-forget，不影响回复。
   */
  elicitationHooks?: {
    fireElicitationEvent(
      message: string,
      requestedSchema?: Record<string, unknown>,
      serverName?: string,
    ): Promise<unknown>;
    fireElicitationResultEvent(
      action: "accept" | "decline" | "cancel",
      content?: Record<string, unknown>,
      serverName?: string,
    ): Promise<unknown>;
  };
  /**
   * 企业 MCP 策略（D13）：denylist / allowlist。
   *
   * 放在 manager 而不是 config 合并层，因为 manager 是**所有**连接路径的必经点：
   * settings/.mcp.json 之外，插件 MCP、`--mcp-config`、IDE 动态注册、运行时 addServer /
   * 重连、插件热重载都直接进 connectAll / addServer，从不经过 mergeMcpConfigs。
   * 只在合并层过闸时这些路径全部绕过，deny 只在一条路径上 win。
   */
  policy?: McpPolicy;
  /** closeAll 之后置真，阻止后台重连 / 探测复活连接 */
  private shutDown = false;
  /** half-open 探测间隔（测试可调小；缺省 HALF_OPEN_PROBE_INTERVAL） */
  halfOpenProbeIntervalMs = HALF_OPEN_PROBE_INTERVAL;
  /** 重连退避基数（测试可调小；缺省 RECONNECT_BASE_DELAY） */
  reconnectBaseDelayMs = RECONNECT_BASE_DELAY;

  /** 连接前的最后一道策略闸（D13）；被拒时记日志并返回 false */
  private passesPolicy(name: string, config: MCPServerConfig): boolean {
    if (!this.policy) return true;
    if (isMcpServerAllowed(name, config, this.policy)) return true;
    getLogger().info("MCP", `策略过滤: ${name} 被 mcpPolicy 拒绝，不建立连接`);
    return false;
  }

  /** 连接所有配置的 MCP 服务器（本地/远程分流并发控制） */
  async connectAll(servers: Record<string, MCPServerConfig>): Promise<Tool[]> {
    const log = getLogger();
    const allTools: Tool[] = [];

    const enabled = Object.entries(servers).filter(([, config]) => config.enabled !== false);
    // D21：禁用的 server 原先在这里被 filter 掉后就从面板里消失了（getStatus 只遍历
    // serverConfigs），DISABLED 枚举全仓零写入。现在登记下来，面板显示「已禁用」。
    for (const [name, config] of Object.entries(servers)) {
      if (config.enabled === false) this.disabledConfigs.set(name, config);
    }
    const skipped = Object.keys(servers).length - enabled.length;
    if (skipped > 0) {
      log.info("MCP", `跳过 ${skipped} 个已禁用的 MCP 服务器`);
    }
    // D13：策略闸下移到连接入口，覆盖插件 / --mcp-config / 热重载等全部来源
    const entries = enabled.filter(([name, config]) => this.passesPolicy(name, config));

    if (entries.length === 0) return allTools;

    log.info("MCP", `开始连接 ${entries.length} 个 MCP 服务器`);

    const local = entries.filter(([, c]) => c.transport === "stdio");
    const remote = entries.filter(([, c]) => c.transport !== "stdio");

    const connectOne = async ([name, config]: [string, MCPServerConfig]): Promise<Tool[]> => {
      this.serverConfigs.set(name, config);
      this.setStatus(name, MCPConnectionStatus.CONNECTING);
      try {
        log.debug("MCP", `连接服务器: ${name}`, config);
        const tools = await this.connectWithTimeout(name, config);
        this.setStatus(name, MCPConnectionStatus.CONNECTED);
        log.info("MCP", `${name} 连接成功，注册 ${tools.length} 个工具`);
        return tools;
      } catch (err: any) {
        this.dropClient(name);
        log.error("MCP", `连接 ${name} 失败`, { error: err.message, stack: err.stack });
        this.setStatus(name, this.failureStatus(config, err), err.message);
        return [];
      }
    };

    const onConnectError = ([name]: [string, MCPServerConfig], err: unknown): Tool[] => {
      log.error("MCP", `连接 ${name} 异常: ${(err as Error)?.message ?? err}`);
      return [];
    };

    const [localResults, remoteResults] = await Promise.all([
      pMap(local, connectOne, LOCAL_BATCH_SIZE, onConnectError),
      pMap(remote, connectOne, REMOTE_BATCH_SIZE, onConnectError),
    ]);

    for (const tools of [...localResults, ...remoteResults]) {
      allTools.push(...tools);
    }

    return allTools;
  }

  /** 连接单个 MCP 服务器 */
  async connect(name: string, config: MCPServerConfig, signal?: AbortSignal): Promise<Tool[]> {
    // D13：公开入口，任何调用方直连也必须过闸（重连循环同样经此）
    if (!this.passesPolicy(name, config)) {
      throw new Error(`MCP 服务器 ${name} 被 mcpPolicy 拒绝`);
    }
    // OAuth 服务器：连接前确保拿到有效 token；首连/凭据失效时触发交互式授权
    if (isOAuthEnabled(config) && config.transport !== "stdio") {
      await this.ensureOAuthToken(name, config);
    }

    try {
      return await this.doConnect(name, config, signal);
    } catch (err: any) {
      // 401 / 需授权：触发一次交互式 OAuth 后重连
      if (isOAuthEnabled(config) && config.transport !== "stdio" && this.isAuthError(err)) {
        getLogger().info("MCP", `${name} 返回未授权，启动 OAuth 授权流程`);
        await this.runOAuthFlow(name, config);
        return await this.doConnect(name, config, signal);
      }
      throw err;
    }
  }

  /**
   * 带总超时的连接（D24）。connectAll / addServer / 断线重连 / half-open 探测四条路径共用。
   *
   * `connect` 内部每个 JSON-RPC 请求有 transport 级超时，但「connect 整体」
   * （initialize + listTools + listResources + listPrompts 串行）没有总闸。原先只有
   * connectAll 与 addServer 各自内联了一份 Promise.race，重连循环是裸 await——
   * 一个「TCP 连上但不回 initialize」的半死 server 会永久冻结重连链，状态停在 RECONNECTING，
   * 而 RECONNECTING 又挡掉后续断线事件。
   *
   * 超时时 abort：让 doConnect 主动 close 传输层（kill stdio 子进程 / abort HTTP·SSE），
   * 避免 connect 变孤儿后子进程泄漏。失败时调用方负责 dropClient。
   */
  private async connectWithTimeout(name: string, config: MCPServerConfig): Promise<Tool[]> {
    const connectTimeout = getMcpTimeout(config.timeout);
    const connectCtl = new AbortController();
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        this.connect(name, config, connectCtl.signal),
        new Promise<never>(
          (_, reject) =>
            (connectTimer = setTimeout(() => {
              connectCtl.abort();
              reject(new Error(`连接超时 (${connectTimeout}ms)`));
            }, connectTimeout)),
        ),
      ]);
    } catch (err) {
      if (!connectCtl.signal.aborted) connectCtl.abort();
      throw err;
    } finally {
      if (connectTimer !== null) clearTimeout(connectTimer);
    }
  }

  /** 关闭并移除指定 server 的 client（失败 / 断线清理共用） */
  private dropClient(name: string): void {
    const client = this.clients.get(name);
    if (client) {
      try {
        client.close();
      } catch {}
      this.clients.delete(name);
    }
  }

  /** 实际建立连接（创建传输 + 初始化 + 发现工具/资源/提示词 + 健康检查） */
  private async doConnect(
    name: string,
    config: MCPServerConfig,
    signal?: AbortSignal,
  ): Promise<Tool[]> {
    // 已 abort（上层超时）→ 直接放弃，不创建任何资源
    if (signal?.aborted) throw new Error(`连接已取消: ${name}`);
    const transport = await this.createTransport(name, config);
    // 超时/取消孤儿清理：abort 触发时主动 close 传输层，kill 启动中的 stdio 子进程
    // 或 abort HTTP·SSE 连接。此时 client 可能尚未 set 进 this.clients，
    // 靠 catch 里的 client.close() 兜不住，必须在这里直接 close transport。
    const onAbort = () => {
      try {
        transport.close();
      } catch {}
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        throw new Error(`连接已取消: ${name}`);
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const timeout = getMcpTimeout(config.timeout);
      const retries = config.retries ?? 2;
      const client = new MCPClient(transport, { timeout, retries });

      // G3 接线：注册 elicitation/create 请求处理器（在 initialize 前注册，
      // 使 initialize 时能声明 capabilities.elicitation 给服务器）。
      client.onRequestMethod("elicitation/create", async (params: unknown) => {
        const { defaultElicitationHandler } = await import("./elicitation.ts");
        const handler = this.elicitationHandler ?? defaultElicitationHandler;
        const p = params as any;
        const hooks = this.elicitationHooks;
        const swallow = (e: unknown) =>
          getLogger().error("HOOK", `elicitation hook 失败: ${(e as Error)?.message ?? e}`);
        hooks
          ?.fireElicitationEvent(String(p?.message ?? ""), p?.requestedSchema, name)
          .catch(swallow);
        const result = await handler(name, p);
        hooks
          ?.fireElicitationResultEvent(
            result.action,
            (result as { content?: Record<string, unknown> }).content,
            name,
          )
          .catch(swallow);
        return result;
      });

      client.onToolsChanged = () => this.refreshTools(name);
      client.onResourcesChanged = () => this.refreshResources(name);
      client.onPromptsChanged = () => this.refreshPrompts(name);
      client.onDisconnected = () => this.handleDisconnect(name);

      const initResult = await client.initialize();
      this.clients.set(name, client);

      // 保存 Server instructions
      const state = this.getState(name);
      state.instructions = truncateInstructions(initResult.instructions);

      // 发现工具（带过滤）
      const toolDefs = filterTools(await client.listTools(), config);
      const tools = this.adaptTools(client, toolDefs, name);
      state.toolCount = tools.length;

      // 发现资源
      await this.refreshResources(name);
      // 发现提示词
      await this.refreshPrompts(name);

      // 启动健康检查（仅有状态连接）
      if (config.transport === "stdio" || config.transport === "sse" || config.transport === "ws") {
        this.startHeartbeat(name);
      }

      return tools;
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  /** MCP 工具定义 → 内部 Tool（D14：工具调用总超时在此注入） */
  private adaptTools(client: MCPClient, defs: MCPToolDefinition[], name: string): Tool[] {
    const toolTimeoutMs = getMcpToolTimeout();
    return defs.map((def) => new MCPToolAdapter(client, def, name, toolTimeoutMs));
  }

  /**
   * 连接失败时该落哪个状态（D21）。OAuth server 的「未授权」类失败（含交互授权超时 /
   * 取消，runOAuthFlow 统一包成 NeedsAuthorizationError）→ NEEDS_AUTH，其余 → FAILED。
   */
  private failureStatus(config: MCPServerConfig, err: unknown): MCPConnectionStatus {
    if (isOAuthEnabled(config) && config.transport !== "stdio" && this.isAuthError(err)) {
      return MCPConnectionStatus.NEEDS_AUTH;
    }
    return MCPConnectionStatus.FAILED;
  }

  /** 判断错误是否为「未授权」（401 / NeedsAuthorizationError） */
  private isAuthError(err: unknown): boolean {
    if (err instanceof NeedsAuthorizationError) return true;
    const msg = (err as Error)?.message ?? "";
    return /\b401\b/.test(msg) || /unauthorized/i.test(msg);
  }

  /**
   * 确保 OAuth 服务器有可用 token。
   * 已有有效 token（或可静默刷新）→ 直接返回；首连无凭据 → 触发交互式授权。
   */
  private async ensureOAuthToken(name: string, config: MCPServerConfig): Promise<void> {
    try {
      await getValidAccessToken(name, config);
    } catch (err) {
      if (err instanceof NeedsAuthorizationError) {
        await this.runOAuthFlow(name, config);
      } else {
        throw err;
      }
    }
  }

  /** 执行交互式 OAuth 授权流程（展示/打开授权 URL，等待用户完成） */
  private async runOAuthFlow(name: string, config: MCPServerConfig): Promise<void> {
    const log = getLogger();
    try {
      await this.performOAuthFlowWithUi(name, config, log);
    } catch (err) {
      // D21：授权没走完（超时 / 取消 / 授权服务器拒绝）对用户而言都是「仍待授权」，
      // 统一成 NeedsAuthorizationError，让 failureStatus 落 NEEDS_AUTH 而不是 FAILED。
      if (err instanceof NeedsAuthorizationError) throw err;
      const wrapped = new NeedsAuthorizationError(name);
      wrapped.message = `${wrapped.message}：${(err as Error)?.message ?? String(err)}`;
      throw wrapped;
    }
  }

  private async performOAuthFlowWithUi(
    name: string,
    config: MCPServerConfig,
    log: ReturnType<typeof getLogger>,
  ): Promise<void> {
    await performOAuthFlow(name, config, (url) => {
      if (this.onOAuthAuthorizationUrl) {
        this.onOAuthAuthorizationUrl(name, url);
      } else {
        // D18：无 UI 回调时只能走日志，而日志会进聚合 / 错误上报 / issue 附件——
        // 这里绝不能出现 state 原值。代价是日志里的链接不可点；交互入口应当注入
        // onOAuthAuthorizationUrl（cli.ts 已直出 stderr，那条展示原文）。
        log.warn(
          "MCP",
          `${name} 需要 OAuth 授权，但未注册授权 URL 展示回调（链接已脱敏）: ${redactOAuthUrl(url)}`,
        );
      }
    });
  }

  /** 创建传输层 */
  private async createTransport(name: string, rawConfig: MCPServerConfig) {
    // D4：command / args / url / headers / env 统一展开（与 policy 过闸、签名去重同一入口）。
    // 原先只展开了 command / args / url，headers 与 env 里的 `${TOKEN}` 原样发出去 → 远端 401。
    // 展开结果只用于本次建连，serverConfigs 里仍存模板原文（重连时按最新环境重新展开）。
    const { config, missing } = expandConfigEnvVars(rawConfig);
    if (missing.length > 0) {
      getLogger().warn(
        "MCP",
        `${name} 配置引用了未设置的环境变量: ${[...new Set(missing)].join(", ")}`,
      );
    }
    const timeout = getMcpTimeout(config.timeout);

    // OAuth 服务器：注入 access token 为 Authorization 头（优先于静态 authToken）
    let oauthHeader: Record<string, string> | undefined;
    if (isOAuthEnabled(config) && config.transport !== "stdio") {
      try {
        const token = await getValidAccessToken(name, config);
        oauthHeader = { Authorization: `Bearer ${token}` };
      } catch (err) {
        // 拿不到 token 时不注入——交给 connect 的 401 重试逻辑触发授权
        if (!(err instanceof NeedsAuthorizationError)) {
          getLogger().warn("MCP", `${name} 获取 OAuth token 失败: ${(err as Error).message}`);
        }
      }
    }

    // IDE 动态注册场景：authToken 注入为 Authorization 头（对标 Claude Code sse-ide/ws-ide）
    let headers: Record<string, string> | undefined =
      oauthHeader || config.authToken || config.headers
        ? {
            ...config.headers,
            ...(config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {}),
            ...oauthHeader, // OAuth token 优先级最高
          }
        : undefined;

    // auth:"sid-backend"：设备凭据只发往 backend.url 同 origin（外泄防线，见 backend-auth.ts）。
    // 它与 oauth / authToken 互斥：后两者写进 Authorization 的值会被这里覆盖。
    if (config.auth === SID_BACKEND_AUTH) {
      if (config.transport === "stdio" || !config.url) {
        throw new Error(`MCP 服务器 ${name} 的 auth:"sid-backend" 需要远程传输与 url`);
      }
      headers = buildSidBackendHeaders(name, config.url, config.headers);
    } else if (config.auth !== undefined) {
      throw new Error(`MCP 服务器 ${name} 的 auth 值不受支持：${String(config.auth)}`);
    }

    if (config.transport === "stdio") {
      if (!config.command) {
        throw new Error(`MCP 服务器 ${name} 缺少 command 配置`);
      }
      return new StdioTransport(config.command, config.args ?? [], config.env, timeout);
    } else if (config.transport === "http") {
      // G4：http 默认走 Streamable HTTP（对齐 CC 与 2025-03-26 规范）
      if (!config.url) {
        throw new Error(`MCP 服务器 ${name} 缺少 url 配置`);
      }
      const url = config.url;
      return new StreamableHTTPTransport(url, headers, timeout);
    } else if (config.transport === "http-json") {
      // 旧单 JSON HTTP 传输（兼容保留，仅在服务器不支持 Streamable 时显式指定）
      if (!config.url) {
        throw new Error(`MCP 服务器 ${name} 缺少 url 配置`);
      }
      const url = config.url;
      return new HTTPTransport(url, headers, timeout);
    } else if (config.transport === "sse") {
      if (!config.url) {
        throw new Error(`MCP 服务器 ${name} 缺少 url 配置`);
      }
      const url = config.url;
      return new SSETransport(url, headers, timeout);
    } else if (config.transport === "ws") {
      if (!config.url) {
        throw new Error(`MCP 服务器 ${name} 缺少 url 配置`);
      }
      const url = config.url;
      return new WebSocketTransport(url, headers, timeout);
    } else {
      throw new Error(`MCP 服务器 ${name} 不支持的传输方式: ${config.transport}`);
    }
  }

  // ─── 工具刷新 ───

  private async refreshTools(name: string): Promise<void> {
    const log = getLogger();
    const client = this.clients.get(name);
    const config = this.serverConfigs.get(name);
    if (!client || !config) return;

    log.info("MCP", `${name} 工具列表变更，刷新中...`);
    try {
      const toolDefs = filterTools(await client.listTools(), config);
      const tools = this.adaptTools(client, toolDefs, name);
      this.getState(name).toolCount = tools.length;
      this.onToolsRefresh?.(name, tools);
      log.info("MCP", `${name} 工具列表已刷新，共 ${tools.length} 个工具`);
    } catch (err: any) {
      log.error("MCP", `${name} 刷新工具列表失败: ${err.message}`);
    }
  }

  // ─── Resources 支持 ───

  private async refreshResources(name: string): Promise<void> {
    const log = getLogger();
    const client = this.clients.get(name);
    if (!client) return;

    try {
      const resources = await client.listResources();
      const state = this.getState(name);
      state.resources = resources;
      state.resourceCount = resources.length;
      if (resources.length > 0) {
        log.info("MCP", `${name} 发现 ${resources.length} 个资源`);
      }
    } catch {
      // 服务器可能不支持 resources，静默忽略
    }
  }

  /** 读取指定服务器的资源 */
  async readResource(serverName: string, uri: string): Promise<string> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP 服务器 ${serverName} 未连接`);
    }
    const result = await client.readResource(uri);
    return result.contents
      .map((c) => c.text ?? (c.blob ? `[二进制数据 ${c.mimeType || "unknown"}]` : ""))
      .join("\n");
  }

  /**
   * G1：读取资源原始 contents（含 blob base64），供 ReadMcpResourceTool 决定
   * 文本进上下文 / blob 落盘。与 readResource（纯文本拼接）分层。
   */
  async readResourceRaw(serverName: string, uri: string) {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP 服务器 ${serverName} 未连接`);
    }
    return client.readResource(uri);
  }

  /** 获取所有服务器的资源列表 */
  getAllResources(): Array<{ serverName: string; resource: MCPResource }> {
    const result: Array<{ serverName: string; resource: MCPResource }> = [];
    for (const [name, state] of this.serverStates) {
      for (const resource of state.resources) {
        result.push({ serverName: name, resource });
      }
    }
    return result;
  }

  // ─── Prompts 支持 ───

  private async refreshPrompts(name: string): Promise<void> {
    const log = getLogger();
    const client = this.clients.get(name);
    if (!client) return;

    try {
      const prompts = await client.listPrompts();
      const state = this.getState(name);
      state.prompts = prompts;
      state.promptCount = prompts.length;
      if (prompts.length > 0) {
        log.info("MCP", `${name} 发现 ${prompts.length} 个提示词`);
      }
      // P1-2：prompt 集合即可用斜杠命令，变了要让补全列表跟上。
      this.notifyPromptsChanged();
    } catch {
      // 服务器可能不支持 prompts，静默忽略
    }
  }

  /** 获取指定服务器的提示词内容 */
  async getPrompt(
    serverName: string,
    promptName: string,
    args?: Record<string, string>,
  ): Promise<Array<{ role: string; content: string }>> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP 服务器 ${serverName} 未连接`);
    }
    const result = await client.getPrompt(promptName, args);
    return result.messages.map((m) => ({
      role: m.role,
      content: m.content.text ?? "",
    }));
  }

  /** 获取所有服务器的提示词列表 */
  getAllPrompts(): Array<{ serverName: string; prompt: MCPPrompt }> {
    const result: Array<{ serverName: string; prompt: MCPPrompt }> = [];
    for (const [name, state] of this.serverStates) {
      for (const prompt of state.prompts) {
        result.push({ serverName: name, prompt });
      }
    }
    return result;
  }

  // ─── 断线重连（差异化策略） ───

  private async handleDisconnect(name: string): Promise<void> {
    const log = getLogger();
    const config = this.serverConfigs.get(name);
    const state = this.getState(name);

    // http / http-json 是无长连接的请求-响应传输，不做心跳（重连按请求粒度处理）
    if (!config || config.transport === "http" || config.transport === "http-json") return;
    // 只有「已连接」才谈得上断线：CONNECTING 期间的关闭由连接入口自己的 catch 处理，
    // RECONNECTING 说明已在重连，FAILED 由 half-open 探测负责恢复（见 scheduleHalfOpenProbe）。
    // D1 接通 onClose 之后，这条 guard 防止连接中途断开时并发起第二条重连链。
    if (state.status !== MCPConnectionStatus.CONNECTED || this.shutDown) return;

    this.stopHeartbeat(name);
    // D23：每一轮断线都是一次新的重连预算。旧实现只在重连成功时清零，
    // 耗尽一次后计数停在 MAX，之后 while 条件恒假——状态锁 + 计数锁双重锁死。
    state.reconnectAttempts = 0;

    // 清理旧 client
    this.dropClient(name);

    // D25：断线即下掉该 server 的工具，重连成功再注册。
    // 不摘的话模型会继续调用一个已断开的 server——adapter 里捕获的是已 close 的旧 client，
    // 拿到的是 isError:true 的「业务错误」，模型以为参数不对、换参数重试，原地空转；
    // stdio 直接 FAILED 时更是整个会话余生都挂着、每轮烧 token。
    // 代价是击穿 prompt cache（工具列表变了）——正确性优先，与 §7.9 同一取舍。
    this.onToolsRefresh?.(name, []);

    // stdio: 不自动重连（子进程崩溃通常是配置错误）
    if (config.transport === "stdio") {
      log.warn("MCP", `${name} 子进程退出，标记为失败（stdio 不自动重连）`);
      this.setStatus(name, MCPConnectionStatus.FAILED, "子进程退出");
      return;
    }

    // 远程（SSE/WS/HTTP）: 指数退避自动重连
    log.warn("MCP", `${name} 连接断开，开始重连...`);
    this.setStatus(name, MCPConnectionStatus.RECONNECTING);

    let retryAfterMs: number | undefined;
    while (state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      state.reconnectAttempts++;
      const delay = this.reconnectDelayMs(state.reconnectAttempts, retryAfterMs);
      log.info(
        "MCP",
        `${name} 第 ${state.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} 次重连，等待 ${Math.round(delay)}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      // 等待期间被主动断开 / 移除（disconnect 会删 config）→ 放弃重连
      if (this.serverConfigs.get(name) !== config || this.shutDown) return;

      try {
        // D24：套总超时。裸 await 时一次挂死的 connect 会永久冻结这条重连链
        const tools = await this.connectWithTimeout(name, config);
        if (this.serverConfigs.get(name) !== config || this.shutDown) {
          this.dropClient(name);
          return;
        }
        state.reconnectAttempts = 0;
        this.setStatus(name, MCPConnectionStatus.CONNECTED);
        log.info("MCP", `${name} 重连成功，注册 ${tools.length} 个工具`);
        this.onToolsRefresh?.(name, tools);
        return;
      } catch (err: any) {
        log.warn("MCP", `${name} 重连失败: ${err.message}`);
        retryAfterMs = getRetryAfterMs(err);
        this.dropClient(name);
      }
    }

    log.error("MCP", `${name} 超过最大重连次数 (${MAX_RECONNECT_ATTEMPTS})，标记为失败`);
    this.setStatus(name, MCPConnectionStatus.FAILED, "超过最大重连次数");
    this.scheduleHalfOpenProbe(name, config);
  }

  /**
   * 第 n 次（从 1 起）重连前的等待（D27）。
   *
   * 与 client.ts 的请求重试同用 computeBackoffMs（指数 + 抖动 + 上限），不再就地写一份无上限的
   * `base × 2^(n-1)`。对端上一次给了 Retry-After（429 / 503）就至少等那么久——按自己的节奏
   * 打一个正在限流的远程 server，会被企业网关判成滥用。Retry-After 本身不受 cap 约束
   * （那是对端的明确要求），只受 parseRetryAfterHeader 的 1 小时合理性上限。
   */
  reconnectDelayMs(attempt: number, retryAfterMs?: number): number {
    const backoff = computeBackoffMs(attempt - 1, this.reconnectBaseDelayMs, RECONNECT_MAX_DELAY);
    return Math.max(backoff, retryAfterMs ?? 0);
  }

  /**
   * 熔断 half-open（D23）：FAILED 之后按更长周期试探一次，成功则回 CONNECTED
   * 并清零计数；失败继续等下一个周期。被主动断开 / 移除（config 已换或已删）时自动停止。
   */
  private scheduleHalfOpenProbe(name: string, config: MCPServerConfig): void {
    const state = this.getState(name);
    this.stopHalfOpenProbe(name);
    state.probeTimer = setTimeout(async () => {
      state.probeTimer = undefined;
      if (this.serverConfigs.get(name) !== config || this.shutDown) return;
      if (state.status !== MCPConnectionStatus.FAILED) return;
      const log = getLogger();
      try {
        // D24：探测同样套总超时，否则一次挂死的探测会让 half-open 永远停在这一轮
        const tools = await this.connectWithTimeout(name, config);
        if (this.serverConfigs.get(name) !== config) {
          this.clients.get(name)?.close();
          return;
        }
        state.reconnectAttempts = 0;
        this.setStatus(name, MCPConnectionStatus.CONNECTED);
        log.info("MCP", `${name} half-open 探测成功，恢复连接，注册 ${tools.length} 个工具`);
        this.onToolsRefresh?.(name, tools);
      } catch (err: any) {
        log.debug("MCP", `${name} half-open 探测失败: ${err?.message ?? err}`);
        this.dropClient(name);
        if (this.serverConfigs.get(name) === config) this.scheduleHalfOpenProbe(name, config);
      }
    }, this.halfOpenProbeIntervalMs);
    // 探测定时器不应阻止进程退出
    (state.probeTimer as any)?.unref?.();
  }

  private stopHalfOpenProbe(name: string): void {
    const state = this.serverStates.get(name);
    if (state?.probeTimer) {
      clearTimeout(state.probeTimer);
      state.probeTimer = undefined;
    }
  }

  // ─── 健康检查 ───

  private startHeartbeat(name: string): void {
    const state = this.getState(name);
    this.stopHeartbeat(name);

    state.heartbeatTimer = setInterval(async () => {
      const client = this.clients.get(name);
      if (!client) {
        this.stopHeartbeat(name);
        return;
      }

      const alive = await client.ping();
      if (!alive) {
        const log = getLogger();
        log.warn("MCP", `${name} 健康检查失败，触发重连`);
        this.stopHeartbeat(name);
        this.handleDisconnect(name);
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(name: string): void {
    const state = this.serverStates.get(name);
    if (state?.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = undefined;
    }
  }

  // ─── 状态管理 ───

  private getState(name: string): ServerState {
    let state = this.serverStates.get(name);
    if (!state) {
      state = {
        status: MCPConnectionStatus.DISCONNECTED,
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
        reconnectAttempts: 0,
        resources: [],
        prompts: [],
      };
      this.serverStates.set(name, state);
    }
    return state;
  }

  private setStatus(name: string, status: MCPConnectionStatus, error?: string): void {
    const state = this.getState(name);
    const prev = state.status;
    state.status = status;
    if (error !== undefined) {
      state.error = error;
    } else if (status === MCPConnectionStatus.CONNECTED) {
      state.error = undefined;
    }
    // P1-2：状态真的变了才广播（避免重连退避期反复同值刷新）。
    // 断开时 getAllPrompts 不再返回该服务器的 prompt，补全里那些命令应当消失。
    if (prev !== status) this.notifyPromptsChanged();
  }

  /** 广播 prompt/连接态变更（监听器异常不影响主流程） */
  private notifyPromptsChanged(): void {
    if (!this.onPromptsChanged) return;
    try {
      this.onPromptsChanged();
    } catch (err) {
      getLogger().debug(
        "MCP",
        `prompt 变更回调异常（忽略）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 获取所有服务器状态 */
  getStatus(): MCPServerStatusInfo[] {
    const statuses: MCPServerStatusInfo[] = [];

    for (const [name, config] of this.serverConfigs) {
      const state = this.getState(name);
      statuses.push({
        name,
        status: state.status,
        toolCount: state.toolCount,
        resourceCount: state.resourceCount,
        promptCount: state.promptCount,
        transport: config.transport,
        error: state.error,
        reconnectAttempts: state.reconnectAttempts > 0 ? state.reconnectAttempts : undefined,
        instructions: state.instructions,
      });
    }

    // D21：禁用的 server 也列出来（受管连接里同名的已经在上面，不重复）
    for (const [name, config] of this.disabledConfigs) {
      if (this.serverConfigs.has(name)) continue;
      statuses.push({
        name,
        status: MCPConnectionStatus.DISABLED,
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
        transport: config.transport,
      });
    }

    return statuses;
  }

  /** 关闭所有连接 */
  closeAll(): void {
    // 进入关停：退避中的重连循环与 half-open 探测醒来后不再建连
    this.shutDown = true;
    for (const [name] of this.serverStates) {
      this.stopHeartbeat(name);
      this.stopHalfOpenProbe(name);
    }
    for (const [, client] of this.clients) {
      client.close();
    }
    this.clients.clear();
  }

  /** 断开指定名称的单个服务器连接（清理 client / state / config） */
  disconnect(name: string): void {
    this.stopHeartbeat(name);
    this.stopHalfOpenProbe(name);
    const client = this.clients.get(name);
    if (client) {
      try {
        client.close();
      } catch {}
      this.clients.delete(name);
    }
    this.serverStates.delete(name);
    this.serverConfigs.delete(name);
  }

  /**
   * 重连插件作用域的 MCP 服务器（用于 /reload-plugins）。
   *
   * 1. 断开所有现存的 plugin: 前缀服务器（旧插件 MCP）
   * 2. 连接传入的新插件 MCP 服务器
   *
   * @param pluginServers 新的插件 MCP 服务器配置（已带 plugin:name:server 前缀）
   * @returns 新连接产生的工具列表
   */
  async reconnectPluginServers(pluginServers: Record<string, MCPServerConfig>): Promise<Tool[]> {
    // 1. 断开所有旧的插件作用域服务器
    const oldPluginServers = [...this.serverConfigs.keys()].filter((n) => n.startsWith("plugin:"));
    for (const name of oldPluginServers) {
      this.disconnect(name);
    }

    // 2. 连接新的插件服务器
    if (Object.keys(pluginServers).length === 0) return [];
    return this.connectAll(pluginServers);
  }

  // ─── 运行时动态增删（IDE 发现 / 用户手动管理 / Bridge 场景） ───

  /**
   * 运行时添加一个 MCP 服务器
   * 用于 IDE 发现后动态注册、用户手动添加等场景。
   * 幂等：同名服务器已存在时先移除再重连，避免连接泄漏。
   */
  async addServer(name: string, config: MCPServerConfig): Promise<Tool[]> {
    const log = getLogger();

    // D13：IDE 动态注册 / 手动添加 / reconnectServer 都走这里，过闸失败不建立任何连接
    if (!this.passesPolicy(name, config)) return [];

    // 同名已存在 → 先清理
    if (this.clients.has(name) || this.serverConfigs.has(name)) {
      this.disconnect(name);
    }

    this.disabledConfigs.delete(name);
    this.serverConfigs.set(name, config);
    this.setStatus(name, MCPConnectionStatus.CONNECTING);

    try {
      const tools = await this.connectWithTimeout(name, config);
      this.setStatus(name, MCPConnectionStatus.CONNECTED);
      log.info("MCP", `动态注册 ${name} 成功，注册 ${tools.length} 个工具`);
      this.onToolsRefresh?.(name, tools);
      return tools;
    } catch (err: any) {
      this.setStatus(name, this.failureStatus(config, err), err.message);
      this.dropClient(name);
      log.error("MCP", `动态注册 ${name} 失败: ${err.message}`);
      return [];
    }
  }

  /**
   * 运行时移除一个 MCP 服务器
   * 用于 IDE 断开、用户手动移除等场景。清理所有状态后通知外部刷新（空工具列表）。
   */
  async removeServer(name: string): Promise<void> {
    this.disconnect(name);
    // 通知外部该服务器的工具全部移除
    this.onToolsRefresh?.(name, []);
  }

  /**
   * M2：运行时禁用一个 server —— 断连 + 注销工具 + 留在面板里显示「已禁用」。
   *
   * 不能只用 removeServer：它会把 server 从列表里整个抹掉，面板上看不到、也就没法再启用。
   * 也不能只用 disconnect：它不调 onToolsRefresh，`mcp__<name>__*` 留在注册表里，
   * 模型下一轮仍能调用、打到已关闭的 client。
   *
   * 持久化（写禁用列表）由调用方负责：manager 只管运行时状态，不知道项目身份。
   * 返回 false 表示既不是受管连接、也不在禁用集合里（名字不存在）。
   */
  async disableServer(name: string): Promise<boolean> {
    const config = this.serverConfigs.get(name) ?? this.disabledConfigs.get(name);
    if (!config) return false;
    await this.removeServer(name);
    this.disabledConfigs.set(name, config);
    this.notifyPromptsChanged();
    return true;
  }

  /**
   * M2：运行时启用一个已禁用的 server（从 disabledConfigs 取回配置 → addServer 当场连接）。
   * 返回 null 表示该名字不在禁用集合里。
   */
  async enableServer(name: string): Promise<Tool[] | null> {
    const config = this.disabledConfigs.get(name);
    if (!config) return null;
    const { enabled: _enabled, ...rest } = config as MCPServerConfig & { enabled?: boolean };
    return this.addServer(name, rest as MCPServerConfig);
  }

  /** 检查指定服务器是否已连接 */
  isConnected(name: string): boolean {
    return (
      this.serverStates.get(name)?.status === MCPConnectionStatus.CONNECTED &&
      this.clients.has(name)
    );
  }

  /**
   * 直接调用指定服务器的工具（不经过 ToolRegistry）。
   * 用于 IDE RPC（openDiff / closeAllDiffTabs 等）等场景。
   * @returns 工具输出文本；服务器未连接或调用失败返回 null
   */
  async callServerTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ output: string; isError?: boolean } | null> {
    const client = this.clients.get(serverName);
    if (!client) return null;

    const result = await client.callTool(toolName, args, signal);
    const text = result.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");

    return { output: text || "", isError: result.isError };
  }

  /** 获取指定服务器的 MCPClient（供 IDE 通知处理器注册等场景） */
  getClient(serverName: string): MCPClient | undefined {
    return this.clients.get(serverName);
  }

  /**
   * 手动触发指定服务器的 OAuth 授权（供 /mcp authenticate 命令）。
   * 跑完交互式授权流程后重连，把真实工具刷新出来。
   * @returns 授权并重连后注册的工具列表
   * @throws 服务器未配置 OAuth、或非远程传输时抛错
   */
  async authenticate(name: string): Promise<Tool[]> {
    const config = this.serverConfigs.get(name);
    if (!config) {
      throw new Error(`未找到 MCP 服务器 "${name}"`);
    }
    if (!isOAuthEnabled(config)) {
      throw new Error(`MCP 服务器 "${name}" 未配置 OAuth（在配置中添加 oauth 字段）`);
    }
    if (config.transport === "stdio") {
      throw new Error(`stdio 传输的服务器 "${name}" 不支持 OAuth`);
    }
    if (!this.passesPolicy(name, config)) {
      throw new Error(`MCP 服务器 "${name}" 被 mcpPolicy 拒绝`);
    }

    // 先断开现有连接
    this.disconnect(name);
    this.serverConfigs.set(name, config);

    // 跑授权流程（失败时状态落 NEEDS_AUTH，面板上仍能再点一次「OAuth 授权」）
    try {
      await this.runOAuthFlow(name, config);
    } catch (err: any) {
      this.setStatus(name, MCPConnectionStatus.NEEDS_AUTH, err.message);
      throw err;
    }

    // 重连并刷新工具（传入超时 signal，防止 doConnect 变孤儿）
    this.setStatus(name, MCPConnectionStatus.CONNECTING);
    const connectTimeout = getMcpTimeout(config.timeout);
    const connectCtl = new AbortController();
    const connectTimer = setTimeout(() => {
      connectCtl.abort();
    }, connectTimeout);
    try {
      const tools = await this.doConnect(name, config, connectCtl.signal);
      this.setStatus(name, MCPConnectionStatus.CONNECTED);
      this.onToolsRefresh?.(name, tools);
      return tools;
    } catch (err: any) {
      if (!connectCtl.signal.aborted) connectCtl.abort();
      const client = this.clients.get(name);
      if (client) {
        client.close();
        this.clients.delete(name);
      }
      this.setStatus(name, MCPConnectionStatus.FAILED, err.message);
      throw err;
    } finally {
      clearTimeout(connectTimer);
    }
  }

  /** 列出所有配置了 OAuth 的服务器名 */
  listOAuthServers(): string[] {
    const result: string[] = [];
    for (const [name, config] of this.serverConfigs) {
      if (isOAuthEnabled(config)) result.push(name);
    }
    return result;
  }

  /**
   * 手动重连指定服务器（断开后重新连接）。
   * 用于用户在交互面板点"重连"的场景。
   */
  async reconnectServer(name: string): Promise<Tool[]> {
    const config = this.serverConfigs.get(name);
    if (!config) {
      throw new Error(`未找到 MCP 服务器配置: ${name}`);
    }
    this.disconnect(name);
    return this.addServer(name, config);
  }

  /**
   * 列出指定服务器的工具定义（含 name/description/inputSchema）。
   * 用于交互面板展示工具列表与详情。
   * @returns 服务器未连接或无工具时返回空数组
   */
  async listServerTools(name: string): Promise<MCPToolDefinition[]> {
    const client = this.clients.get(name);
    if (!client) return [];
    try {
      return await client.listTools();
    } catch {
      return [];
    }
  }
}
