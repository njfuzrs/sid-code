/**
 * 回归：`.mcp.json` 的 CC 格式（`type` 字段 / stdio 省略不写）归一成 sid 的 `transport`。
 *
 * 事故：`~/.mcp.json` 里一条 CC 写法的 server（只有 command + args）在每次启动都报
 * `mcpServers.<name>.transport: 无效值 "undefined"`——文件是两家共用的，CC 的写法合法。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  normalizeMcpServerEntry,
  loadProjectMcpServers,
} from "@sid-code/core/mcp/project-files.ts";
import { validateConfig } from "@sid-code/core/config/schema.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";

describe("normalizeMcpServerEntry", () => {
  test("只有 command → stdio（CC 默认值）", () => {
    expect(normalizeMcpServerEntry({ command: "npx", args: ["-y", "x"] }).transport).toBe("stdio");
  });

  test("type 映射为 transport，streamable-http 归 http，type 字段被移除", () => {
    const sse = normalizeMcpServerEntry({ type: "sse", url: "https://a" }) as any;
    expect(sse.transport).toBe("sse");
    expect(sse.type).toBeUndefined();
    expect(normalizeMcpServerEntry({ type: "streamable-http", url: "https://a" }).transport).toBe(
      "http",
    );
  });

  test("只有 url → http", () => {
    expect(normalizeMcpServerEntry({ url: "https://a" }).transport).toBe("http");
  });

  test("显式 transport 优先，不被 type / command 改写", () => {
    expect(
      normalizeMcpServerEntry({ transport: "ws", type: "sse", url: "wss://a", command: "x" })
        .transport,
    ).toBe("ws");
  });

  test("无法推断时保持缺省，交给校验器报错（不猜）", () => {
    expect(normalizeMcpServerEntry({ env: {} }).transport).toBeUndefined();
  });
});

describe(".mcp.json 加载端到端", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-cc-format-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("CC 写法的 server 加载后通过配置校验", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { cc: { command: "npx", args: ["-y", "pkg"] } } }),
    );
    const { servers } = loadProjectMcpServers(dir);
    expect(servers.cc.transport).toBe("stdio");
    const result = validateConfig({ ...defaultConfig, mcpServers: servers } as any);
    expect(result.errors.some((e) => e.path.startsWith("mcpServers.cc"))).toBe(false);
  });
});
