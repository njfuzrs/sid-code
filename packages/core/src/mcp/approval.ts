/**
 * MCP 项目级 .mcp.json 审批机制
 * 审批记录存储在 ~/.sid-code/state/mcp-approvals.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { sidPaths } from "../config/paths.ts";

export type ApprovalStatus = "approved" | "rejected" | "pending";

interface ApprovalStore {
  approved: string[];
  rejected: string[];
  approveAll?: boolean;
}

/** 审批记录路径：~/.sid-code/state/mcp-approvals.json */
function approvalsPath(): string {
  return sidPaths.stateFile("mcp-approvals.json");
}

function loadApprovals(): ApprovalStore {
  try {
    if (existsSync(approvalsPath())) {
      return JSON.parse(readFileSync(approvalsPath(), "utf-8"));
    }
  } catch {}
  return { approved: [], rejected: [] };
}

function saveApprovals(store: ApprovalStore): void {
  const dir = sidPaths.state();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(approvalsPath(), JSON.stringify(store, null, 2));
}

/**
 * 检查项目级 MCP Server 的审批状态
 */
export function getProjectServerApproval(serverName: string, projectPath: string): ApprovalStatus {
  const approvals = loadApprovals();
  const key = `${projectPath}:${serverName}`;

  if (approvals.rejected?.includes(key)) return "rejected";
  if (approvals.approved?.includes(key)) return "approved";
  if (approvals.approveAll) return "approved";
  return "pending";
}

/**
 * 批准项目级 MCP Server
 */
export function approveProjectServer(serverName: string, projectPath: string): void {
  const approvals = loadApprovals();
  const key = `${projectPath}:${serverName}`;
  if (!approvals.approved.includes(key)) {
    approvals.approved.push(key);
  }
  approvals.rejected = approvals.rejected.filter((k) => k !== key);
  saveApprovals(approvals);
}

/**
 * 拒绝项目级 MCP Server
 */
export function rejectProjectServer(serverName: string, projectPath: string): void {
  const approvals = loadApprovals();
  const key = `${projectPath}:${serverName}`;
  if (!approvals.rejected.includes(key)) {
    approvals.rejected.push(key);
  }
  approvals.approved = approvals.approved.filter((k) => k !== key);
  saveApprovals(approvals);
}

/**
 * 设置全局批准所有项目 Server
 */
export function setApproveAll(value: boolean): void {
  const approvals = loadApprovals();
  approvals.approveAll = value;
  saveApprovals(approvals);
}

// ─── 待审批快照（SEC-AUDIT-2026-07-19 P1）────────────────────────────────────
//
// loadConfig 在合并 MCP 配置时把 pending 的项目级 server **排除出生效列表**，
// 并登记到这里。/mcp 面板读它来展示"有 N 个待审批 server"，用户批准后写入
// approved 列表，下次启动即加载。
//
// 为什么用模块级单例而不挂在 Config 上：Config 会被序列化进会话快照、被 Zod
// 校验、被项目级 settings 合并——把"本次启动的临时审批状态"塞进去会污染这些
// 通路（早先的 `_pendingApproval` 就是塞在 serverConfig 里，结果既被透传到
// 生效列表又无人读取）。审批状态是进程内的一次性信息，不该进配置结构。

/** 待审批的项目级 server 名 → 其配置（仅本进程内有效） */
let pendingApproval: Record<string, unknown> = {};
/** 待审批 server 所属的项目路径 */
let pendingApprovalProject = "";

/** 登记待审批快照（loadConfig 调用） */
export function setPendingApprovalServers(
  servers: Record<string, unknown>,
  projectPath: string,
): void {
  pendingApproval = servers;
  pendingApprovalProject = projectPath;
}

/** 读取待审批 server 名单（/mcp 面板调用） */
export function getPendingApprovalServers(): { names: string[]; projectPath: string } {
  return { names: Object.keys(pendingApproval), projectPath: pendingApprovalProject };
}

/**
 * 批准一个待审批 server 并从快照中移除。
 * 返回 true 表示确实批准了（名字在快照里）。
 *
 * D17：本函数只写持久化状态、不建连——它在 core 的审批层，不持有 MCPManager。
 * 运行中热连接的入口是存在的（`MCPManager.addServer`），会话内的调用方应当用
 * {@link approveAndConnectPendingServer}；`sid-code mcp approve` 这类独立子进程
 * 没有 manager，只能提示「下次启动生效」。（旧注释说「运行中没有补连入口」，不成立。）
 */
export function approvePendingServer(serverName: string): boolean {
  if (!(serverName in pendingApproval)) return false;
  approveProjectServer(serverName, pendingApprovalProject);
  delete pendingApproval[serverName];
  return true;
}

/**
 * 会话内批准并立即连接（D17）。`connect` 通常是 `mcpManager.addServer.bind(mcpManager)`，
 * 它自己过 mcpPolicy 闸、带总超时、成功后经 onToolsRefresh 把工具注册进 registry。
 *
 * 返回 null 表示名字不在待审批快照里；否则返回连上后注册的工具数（连接失败为 0，
 * 批准状态已落盘，下次启动仍会尝试）。
 */
export async function approveAndConnectPendingServer<T>(
  serverName: string,
  connect: (name: string, config: never) => Promise<T[]>,
): Promise<number | null> {
  const config = pendingApproval[serverName];
  if (config === undefined) return null;
  approvePendingServer(serverName);
  const tools = await connect(serverName, config as never);
  return tools.length;
}

/** 拒绝一个待审批 server 并从快照中移除（后续启动直接跳过，不再询问）。 */
export function rejectPendingServer(serverName: string): boolean {
  if (!(serverName in pendingApproval)) return false;
  rejectProjectServer(serverName, pendingApprovalProject);
  delete pendingApproval[serverName];
  return true;
}

/** 测试辅助：重置模块级快照 */
export function __resetPendingApproval(): void {
  pendingApproval = {};
  pendingApprovalProject = "";
}
