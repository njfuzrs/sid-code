/**
 * MCP 项目级 .mcp.json 审批机制
 * 审批记录存储在 ~/.sid-code/mcp-approvals.json
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

export type ApprovalStatus = 'approved' | 'rejected' | 'pending';

interface ApprovalStore {
  approved: string[];
  rejected: string[];
  approveAll?: boolean;
}

const APPROVALS_PATH = join(homedir(), '.sid-code', 'mcp-approvals.json');

function loadApprovals(): ApprovalStore {
  try {
    if (existsSync(APPROVALS_PATH)) {
      return JSON.parse(readFileSync(APPROVALS_PATH, 'utf-8'));
    }
  } catch {}
  return { approved: [], rejected: [] };
}

function saveApprovals(store: ApprovalStore): void {
  const dir = join(homedir(), '.sid-code');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(APPROVALS_PATH, JSON.stringify(store, null, 2));
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
