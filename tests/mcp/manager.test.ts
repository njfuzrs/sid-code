/**
 * MCPManager 测试
 * 测试 enabled 过滤、工具名格式、getStatus、SSE 传输支持、工具过滤、状态枚举
 */

import { describe, test, expect } from "bun:test";
import { MCPManager } from "@sid-code/core/mcp/manager.ts";
import { MCPConnectionStatus } from "@sid-code/core/mcp/types.ts";
import type { MCPServerConfig } from "@sid-code/core/config/config.ts";

describe("MCPManager", () => {
  test("connectAll 过滤 enabled === false 的服务器", async () => {
    const servers: Record<string, MCPServerConfig> = {
      active: {
        transport: "stdio",
        command: "echo",
        args: ["test"],
        enabled: true,
      },
      disabled: {
        transport: "stdio",
        command: "echo",
        args: ["test"],
        enabled: false,
      },
      defaultEnabled: {
        transport: "stdio",
        command: "echo",
        args: ["test"],
        // enabled 未设置，默认 true
      },
    };

    const manager = new MCPManager();

    // connectAll 会尝试连接，但 echo 不是有效的 MCP 服务器，会失败
    // 关键是验证 disabled 的服务器不会被尝试连接
    await manager.connectAll(servers);

    // 获取状态，disabled 不应该出现
    const statuses = manager.getStatus();
    const names = statuses.map(s => s.name);
    expect(names).toContain("active");
    expect(names).toContain("defaultEnabled");
    expect(names).not.toContain("disabled");

    manager.closeAll();
  });

  test("getStatus 返回正确的服务器状态（使用状态枚举）", async () => {
    const servers: Record<string, MCPServerConfig> = {
      server1: {
        transport: "stdio",
        command: "nonexistent-command-xyz",
        args: [],
      },
    };

    const manager = new MCPManager();
    await manager.connectAll(servers);

    const statuses = manager.getStatus();
    expect(statuses.length).toBe(1);
    expect(statuses[0].name).toBe("server1");
    expect(statuses[0].transport).toBe("stdio");
    // 连接失败（命令不存在）
    expect(statuses[0].status).toBe(MCPConnectionStatus.FAILED);
    expect(statuses[0].error).toBeDefined();
    // 新字段默认值
    expect(statuses[0].resourceCount).toBe(0);
    expect(statuses[0].promptCount).toBe(0);

    manager.closeAll();
  });

  test("connect 拒绝缺少 command 的 stdio 配置", async () => {
    const manager = new MCPManager();

    await expect(
      manager.connect("bad", { transport: "stdio" }),
    ).rejects.toThrow("缺少 command 配置");

    manager.closeAll();
  });

  test("connect 拒绝缺少 url 的 http 配置", async () => {
    const manager = new MCPManager();

    await expect(
      manager.connect("bad", { transport: "http" }),
    ).rejects.toThrow("缺少 url 配置");

    manager.closeAll();
  });

  test("connect 拒绝缺少 url 的 sse 配置", async () => {
    const manager = new MCPManager();

    await expect(
      manager.connect("bad", { transport: "sse" }),
    ).rejects.toThrow("缺少 url 配置");

    manager.closeAll();
  });

  test("connect 拒绝不支持的传输方式", async () => {
    const manager = new MCPManager();

    await expect(
      manager.connect("bad", { transport: "websocket" as any }),
    ).rejects.toThrow("不支持的传输方式");

    manager.closeAll();
  });

  test("closeAll 清空所有客户端", async () => {
    const manager = new MCPManager();

    // 尝试连接（会失败，但不影响 closeAll 测试）
    await manager.connectAll({
      s1: { transport: "stdio", command: "nonexistent-xyz" },
    });

    manager.closeAll();
    const statuses = manager.getStatus();
    // getStatus 仍然返回配置过的服务器（但状态为 FAILED）
    expect(statuses.length).toBe(1);
  });

  test("connectAll 空配置返回空数组", async () => {
    const manager = new MCPManager();
    const tools = await manager.connectAll({});
    expect(tools).toEqual([]);
    manager.closeAll();
  });

  test("timeout 和 retries 配置传递", async () => {
    const servers: Record<string, MCPServerConfig> = {
      test: {
        transport: "stdio",
        command: "nonexistent-xyz",
        timeout: 5000,
        retries: 1,
      },
    };

    const manager = new MCPManager();
    // 连接会失败，但验证不会因为配置参数而崩溃
    const tools = await manager.connectAll(servers);
    expect(tools).toEqual([]);

    const statuses = manager.getStatus();
    expect(statuses[0].status).toBe(MCPConnectionStatus.FAILED);

    manager.closeAll();
  });

  test("getAllResources 初始为空", () => {
    const manager = new MCPManager();
    expect(manager.getAllResources()).toEqual([]);
    manager.closeAll();
  });

  test("getAllPrompts 初始为空", () => {
    const manager = new MCPManager();
    expect(manager.getAllPrompts()).toEqual([]);
    manager.closeAll();
  });

  test("readResource 未连接时抛错", async () => {
    const manager = new MCPManager();
    await expect(
      manager.readResource("nonexistent", "file:///test"),
    ).rejects.toThrow("未连接");
    manager.closeAll();
  });

  test("getPrompt 未连接时抛错", async () => {
    const manager = new MCPManager();
    await expect(
      manager.getPrompt("nonexistent", "test-prompt"),
    ).rejects.toThrow("未连接");
    manager.closeAll();
  });
});
