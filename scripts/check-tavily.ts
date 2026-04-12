#!/usr/bin/env bun
import { exit } from 'process';

const apiKey = process.env.TAVILY_API_KEY;
if (!apiKey) {
  console.error('❌ Error: 环境变量 TAVILY_API_KEY 未设置');
  exit(1);
}

// 请求 usage API
async function checkUsage() {
  try {
    const res = await fetch('https://api.tavily.com/usage', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'GET',
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }

    const data = await res.json() as {
      key: { usage: number; limit: number | null; search_usage: number; crawl_usage: number; extract_usage: number; map_usage: number; research_usage: number };
      account: { current_plan: string; plan_limit: number; plan_usage: number };
    };

    const { key, account } = data;
    const totalUsed = key.usage;
    const planLimit = account.plan_limit;
    const pct = planLimit > 0 ? Math.round((totalUsed / planLimit) * 100) : 0;

    console.log('\n📊 Tavily API Usage Report');
    console.log('─'.repeat(40));
    console.log(`🎯 Plan:     ${account.current_plan}`);
    console.log(`✅ Total:    ${totalUsed.toLocaleString()} / ${planLimit.toLocaleString()} calls`);
    console.log(`📈 Usage:    ${pct}%`);
    if (planLimit > 0) {
      console.log(`✅ Remaining: ${(planLimit - totalUsed).toLocaleString()} calls`);
    }

    console.log('\n🔍 Breakdown:');
    console.log(`   • Search:   ${key.search_usage.toLocaleString()}`);
    console.log(`   • Extract:  ${key.extract_usage.toLocaleString()}`);
    console.log(`   • Crawl:    ${key.crawl_usage.toLocaleString()}`);
    console.log(`   • Map:      ${key.map_usage.toLocaleString()}`);
    console.log(`   • Research: ${key.research_usage.toLocaleString()}`);

    if (pct >= 90 && planLimit > 0) {
      console.log('\n⚠️  Warning: You are approaching your quota!');
    }
  } catch (e) {
    console.error('\n❌ Failed to fetch usage:', e instanceof Error ? e.message : String(e));
  }
}

checkUsage();
