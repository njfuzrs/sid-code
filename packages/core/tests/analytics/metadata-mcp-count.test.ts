// 事件元数据 · MCP server 数（B22）
//
// 背景：`_ctx_mcp_server_count` 字段一直在，但全仓没有任何调用方回填它。
// 本机 1,616 个会话的这个字段全部是 0，而同期 debug.log 显示 5 个 server 连接成功。
// 与 metadata-version.test.ts 同一形态：字段存在、类型正确，**只有值是废的**。
//
// 难点在时序：MCP connectAll 是异步的，可能早于也可能晚于 analytics 初始化。
// 两种顺序都必须断言——只测一种，另一种恰好是被静默丢掉的那次。

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  getEventMetadataFields,
  primeMetadata,
  setMcpServerCount,
  __resetMetadataForTest,
} from "../../src/analytics/metadata.ts";

describe("事件元数据 · MCP server 数", () => {
  beforeEach(() => __resetMetadataForTest());
  afterEach(() => __resetMetadataForTest());

  test("缺省为 0（未配置 MCP 的会话）", () => {
    expect(getEventMetadataFields()._ctx_mcp_server_count).toBe(0);
  });

  test("先初始化 analytics、后连上 MCP：回填生效", () => {
    primeMetadata({ sessionId: "s1" });
    setMcpServerCount(5);
    expect(getEventMetadataFields()._ctx_mcp_server_count).toBe(5);
  });

  test("先连上 MCP、后初始化 analytics：暂存值不丢", () => {
    setMcpServerCount(3);
    primeMetadata({ sessionId: "s1" });
    expect(getEventMetadataFields()._ctx_mcp_server_count).toBe(3);
  });

  test("重连后再次回填覆盖旧值", () => {
    setMcpServerCount(5);
    setMcpServerCount(4);
    expect(getEventMetadataFields()._ctx_mcp_server_count).toBe(4);
  });
});
