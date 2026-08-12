#!/usr/bin/env bun
import { exit } from "process";
import { readFileSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";

let apiKey: string | undefined;
try {
  const mcpPath = resolve(import.meta.dirname, "..", ".mcp.json");
  const mcp = JSON.parse(readFileSync(mcpPath, "utf-8"));
  apiKey = mcp?.mcpServers?.tavily?.env?.TAVILY_API_KEY;
} catch (err) {
  console.error("❌ Error: 无法读取 .mcp.json", err);
  exit(1);
}
if (!apiKey) {
  console.error("❌ Error: .mcp.json 中未配置 TAVILY_API_KEY");
  exit(1);
}

// 与 tavily-mcp 官方客户端保持一致的 header，便于被 WAF 放行
const commonHeaders = {
  accept: "application/json",
  "content-type": "application/json",
  Authorization: `Bearer ${apiKey}`,
  "X-Client-Source": "MCP",
  "X-Session-Id": randomUUID(),
};

type UsageResponse = {
  key: {
    usage: number;
    limit: number | null;
    search_usage: number;
    crawl_usage: number;
    extract_usage: number;
    map_usage: number;
    research_usage: number;
  };
  account: {
    current_plan: string;
    plan_limit: number;
    plan_usage: number;
  };
};

async function tryFetchUsage(): Promise<
  | { ok: true; data: UsageResponse }
  | { ok: false; reason: "waf" | "http" | "parse"; detail: string }
> {
  const res = await fetch("https://api.tavily.com/usage", {
    method: "GET",
    headers: commonHeaders,
  });

  if (res.headers.get("x-amzn-waf-action")) {
    return {
      ok: false,
      reason: "waf",
      detail: `status=${res.status} x-amzn-waf-action=${res.headers.get("x-amzn-waf-action")}`,
    };
  }

  if (res.status !== 200) {
    const body = await res.text();
    return {
      ok: false,
      reason: "http",
      detail: `HTTP ${res.status}: ${body.slice(0, 200) || "<empty body>"}`,
    };
  }

  const raw = await res.text();
  try {
    const data = JSON.parse(raw) as UsageResponse;
    if (!data?.key || !data?.account) {
      return { ok: false, reason: "parse", detail: `缺字段: ${raw.slice(0, 200)}` };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: "parse", detail: raw.slice(0, 200) };
  }
}

async function healthCheckViaSearch(): Promise<{
  valid: boolean;
  status: number;
  detail: string;
}> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({ query: "ping", max_results: 5 }),
  });
  const body = await res.text();
  if (res.status === 200) {
    return { valid: true, status: 200, detail: "search 接口可用" };
  }
  if (res.status === 401) {
    return { valid: false, status: 401, detail: "API key 无效" };
  }
  if (res.status === 432) {
    return { valid: false, status: 432, detail: `额度耗尽: ${body.slice(0, 200)}` };
  }
  if (res.status === 429) {
    return { valid: false, status: 429, detail: "被限流（rate limit）" };
  }
  return { valid: false, status: res.status, detail: body.slice(0, 200) };
}

function printUsage(data: UsageResponse) {
  const { key, account } = data;
  const totalUsed = key.usage;
  const planLimit = account.plan_limit;
  const pct = planLimit > 0 ? Math.round((totalUsed / planLimit) * 100) : 0;

  console.log("\n📊 Tavily API Usage Report");
  console.log("─".repeat(40));
  console.log(`🎯 Plan:     ${account.current_plan}`);
  console.log(`✅ Total:    ${totalUsed.toLocaleString()} / ${planLimit.toLocaleString()} calls`);
  console.log(`📈 Usage:    ${pct}%`);
  if (planLimit > 0) {
    console.log(`✅ Remaining: ${(planLimit - totalUsed).toLocaleString()} calls`);
  }

  console.log("\n🔍 Breakdown:");
  console.log(`   • Search:   ${key.search_usage.toLocaleString()}`);
  console.log(`   • Extract:  ${key.extract_usage.toLocaleString()}`);
  console.log(`   • Crawl:    ${key.crawl_usage.toLocaleString()}`);
  console.log(`   • Map:      ${key.map_usage.toLocaleString()}`);
  console.log(`   • Research: ${key.research_usage.toLocaleString()}`);

  if (pct >= 90 && planLimit > 0) {
    console.log("\n⚠️  Warning: You are approaching your quota!");
  }
}

async function main() {
  const usage = await tryFetchUsage();
  if (usage.ok) {
    printUsage(usage.data);
    return;
  }

  // /usage 被 Tavily 的 WAF 当作仅限网页访问的端点，CLI 常被 challenge
  // 降级为 key 健康检查：打一次 /search 看 key 是否真的有效
  console.log("\nℹ️  /usage 接口不可用，降级为 key 健康检查");
  console.log(`   原因: ${usage.detail}`);
  if (usage.reason === "waf") {
    console.log(
      "   说明: Tavily 的 /usage 接口挂了 AWS WAF 浏览器挑战，CLI 无法解（官方 tavily-mcp / @tavily/core 都不调用此接口）",
    );
  }

  const health = await healthCheckViaSearch();
  console.log("\n🔑 API Key Health Check");
  console.log("─".repeat(40));
  if (health.valid) {
    console.log(`✅ API key 有效 (/search 返回 200)`);
    console.log(`\n💡 想查精确用量请打开: https://app.tavily.com/`);
  } else {
    console.log(`❌ API key 不可用 (HTTP ${health.status})`);
    console.log(`   ${health.detail}`);
  }
}

main().catch((e) => {
  console.error("\n❌ 脚本执行出错:", e instanceof Error ? e.message : String(e));
  exit(1);
});
