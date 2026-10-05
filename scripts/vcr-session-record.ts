#!/usr/bin/env bun
/**
 * vcr-session-record —— 把一次真实会话的 raw.jsonl 转成会话级回放夹具（含脱敏）
 *
 * 评测接入 CI/CD 方案 P1 第 4 条。录制半边复用 raw.jsonl（理由见 replay-provider.ts 文件头），
 * 本脚本只做「挑字段 + 脱敏 + 标注路由」三件事，产物落到
 * `packages/core/tests/fixtures/vcr/sessions/<name>.json`，由 session-replay.test.ts 自动拾取。
 *
 * 只保留 response.content（text / tool_use）与 usage —— **请求侧一律丢弃**：
 * 回放断言比较的是「本仓代码此刻序列化出的请求」，录制时的请求只会把当时的
 * system prompt（含内网地址、项目规则、记忆）原样带进仓库。thinking 块也丢弃
 * （带 signature，且与断言无关）。
 *
 * raw.jsonl 区分不出某一轮是主循环还是子代理发的，所以用 `--sub` 显式标注：
 *   bun scripts/vcr-session-record.ts <raw.jsonl> --name anthropic-foo --family anthropic-messages \
 *     --model claude-sonnet-4-5 --prompt "原始用户输入" --sub 4,5
 *
 * 脱敏规则见 {@link redact}；录完务必人工过目一遍 diff 再提交。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** 脱敏：密钥 / Bearer / 内网与回环地址 / 用户 home 路径 / 邮箱 */
export function redact(s: string): string {
  return s
    .replace(/\b(sk|pk|ak)-[A-Za-z0-9_-]{8,}/g, "$1-REDACTED")
    .replace(
      /(authorization|x-api-key|api[_-]?key)(["'\s:=]+)(Bearer\s+)?[^\s"',}]+/gi,
      "$1$2$3REDACTED",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer REDACTED")
    .replace(
      /\b(?:10\.\d{1,3}|127\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?::\d+)?/g,
      "internal.vcr.test",
    )
    .replace(/\/(Users|home)\/[^/\s"']+/g, "/$1/user")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "user@example.com");
}

function redactDeep<T>(v: T): T {
  return JSON.parse(JSON.stringify(v), (_k, val) => (typeof val === "string" ? redact(val) : val));
}

export function rawToSessionFixture(
  rawText: string,
  opts: { family: string; model: string; prompt: string; description: string; sub: Set<number> },
) {
  const turns: unknown[] = [];
  for (const line of rawText.split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if ("type" in o || !o.response) continue; // request_sent 标记行
    const content = (o.response.content ?? []).filter(
      (b: any) => b.type === "text" || b.type === "tool_use",
    );
    const u = o.usage ?? {};
    turns.push({
      agent: opts.sub.has(o.index) ? "sub" : "main",
      response: {
        content: content.map((b: any) =>
          b.type === "text"
            ? { type: "text", text: b.text }
            : { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} },
        ),
        stop_reason: content.some((b: any) => b.type === "tool_use") ? "tool_use" : "end_turn",
      },
      usage: {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        ...(u.cache_read_input_tokens
          ? { cache_read_input_tokens: u.cache_read_input_tokens }
          : {}),
        ...(u.cache_creation_input_tokens
          ? { cache_creation_input_tokens: u.cache_creation_input_tokens }
          : {}),
      },
    });
  }
  return redactDeep({
    description: opts.description,
    family: opts.family,
    model: opts.model,
    prompt: opts.prompt,
    turns,
  });
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      family: { type: "string" },
      model: { type: "string" },
      prompt: { type: "string" },
      description: { type: "string", default: "" },
      sub: { type: "string", default: "" },
    },
  });
  const [raw] = positionals;
  if (!raw || !values.name || !values.family || !values.model || !values.prompt) {
    console.error(
      "用法见文件头注释：需要 <raw.jsonl> --name --family --model --prompt [--sub i,j]",
    );
    process.exit(2);
  }
  const sub = new Set(values.sub!.split(",").filter(Boolean).map(Number));
  const fx = rawToSessionFixture(readFileSync(raw, "utf-8"), {
    family: values.family,
    model: values.model,
    prompt: values.prompt,
    description: values.description!,
    sub,
  });
  const out = join(
    import.meta.dir,
    "..",
    "packages/core/tests/fixtures/vcr/sessions",
    `${values.name}.json`,
  );
  writeFileSync(out, JSON.stringify(fx, null, 2) + "\n", "utf-8");
  console.log(`已写入 ${out}（${(fx as any).turns.length} 轮）。提交前请人工过目脱敏结果。`);
}
