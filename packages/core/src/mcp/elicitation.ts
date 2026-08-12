/**
 * MCP Elicitation 机制
 * Server 向用户请求额外信息（表单填写、OAuth 授权 URL 等）
 */

import type { ElicitRequest, ElicitResult } from "./types.ts";

export type ElicitationHandler = (
  serverName: string,
  params: ElicitRequest["params"],
  signal?: AbortSignal,
) => Promise<ElicitResult>;

/**
 * 默认 handler：拒绝所有 elicitation 请求
 */
export const defaultElicitationHandler: ElicitationHandler = async () => {
  return { action: "cancel" };
};

/**
 * CLI 交互式 handler
 * 在 CLI 环境中通过终端交互处理 Elicitation
 */
export async function cliElicitationHandler(
  serverName: string,
  params: ElicitRequest["params"],
  _signal?: AbortSignal,
): Promise<ElicitResult> {
  // URL 模式：提示用户打开浏览器
  if (params.url) {
    console.log(`\nMCP 服务器 ${serverName} 请求您打开以下链接完成授权：`);
    console.log(params.url);
    console.log("授权完成后按 Enter 继续...\n");
    return { action: "accept" };
  }

  // 表单模式：显示消息，返回取消（完整表单交互需要 UI 层支持）
  if (params.requestedSchema) {
    console.log(`\nMCP 服务器 ${serverName}: ${params.message}`);
    console.log("(表单交互暂不支持，已取消)\n");
    return { action: "cancel" };
  }

  // 简单消息
  console.log(`\nMCP 服务器 ${serverName}: ${params.message}\n`);
  return { action: "accept" };
}
