/**
 * MCP 项目级 .mcp.json 审批机制
 * 审批记录存储在 ~/.sid-code/state/mcp-approvals.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { sidPaths } from "../config/paths.ts";

export type ApprovalStatus = 'approved' | 'rejected' | 'pending';

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
      return JSON.parse(readFileSync(approvalsPath(), 'utf-8'));
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
export function getProjectServerApproval(
  serverName: string,
  projectPath: string,
): ApprovalStatus {
  const approvals = loadApprovals();
  const key = `${projectPath}:${serverName}`;

  if (approvals.rejected?.includes(key)) return 'rejected';
  if (approvals.approved?.includes(key)) return 'approved';
  if (approvals.approveAll) return 'approved';
  return 'pending';
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
  approvals.rejected = approvals.rejected.filter(k => k !== key);
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
  approvals.approved = approvals.approved.filter(k => k !== key);
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
