/**
 * 数据主权整改 PR-B（P1-1 至 P1-10）回归。
 *
 * 每条规则都配一个「真实格式必须被遮」与一个「误伤反例必须原样」：
 * 规则的价值一半在命中、一半在不误伤——误伤会改写 tool_input.command / file_path，
 * 让评测的分歧分析失真（方案 §8.3）。
 *
 * ⚠ 测试里的凭证全部是**运行时拼接的合成值**：不在源码里写出完整的凭证字面量，
 * 避免仓库被 secret scanning 误报，也避免有人误以为这里有真 key。
 *
 * ⚠ 落盘隔离：所有写盘都指向 mkdtemp 目录（warn.log 路径、dumpDir、TraceWriter baseDir）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  maskSensitiveData,
  maskSensitiveJson,
  REDACTION_FAILED_PLACEHOLDER,
} from "@sid-code/core/permission/sensitive.ts";
import { maskJsonSafe } from "@sid-code/core/trace/writer.ts";
import { redactHomeDir } from "@sid-code/core/trace/redact-home.ts";
import { UploadManager } from "@sid-code/core/trace/uploader.ts";
import { initLogger, getLogger, LogLevel } from "@sid-code/core/debug/logger.ts";
import { dumpProtocolViolation } from "@sid-code/core/llm/protocol-sentinel.ts";
import { checkMessageHistoryIntegrity } from "@sid-code/core/agent/message-invariants.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

/** U3：上传体改为流式 multipart（不再是 FormData 对象），断言前先解析回 FormData */
async function parseUploadBody(init: any): Promise<FormData> {
  return new Response(init.body, {
    headers: { "content-type": init.headers["Content-Type"] },
  }).formData();
}

// ─── 合成凭证（运行时拼接） ───

const ALNUM = "AbCdEf0123GhIjKl4567MnOpQr89StUvWx";
const SK_PROJ = "sk-" + "proj-" + ALNUM + "_yz-12";
const SK_SVCACCT = "sk-" + "svcacct-" + ALNUM;
const SK_PLAIN = "sk-" + ALNUM;
const GH_PAT = "github" + "_pat_" + "11ABCDEFG0" + ALNUM + "_" + ALNUM;
const API_VALUE = "a8f3k2j9d0s7f6g5h4j3k2l1";
const PEM_BODY = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW";
const pem = (kind: string, withEnd = true): string =>
  `-----BEGIN ${kind}PRIVATE KEY-----\n${PEM_BODY}\n${PEM_BODY}` +
  (withEnd ? `\n-----END ${kind}PRIVATE KEY-----` : "");

/** 方案 §6 PR-B 实测误伤的路径 + 表达式赋值 + 占位：新规则**不得**改写这些 */
const FALSE_POSITIVES = [
  "cd tasks/task-qemu-alpine-ssh-key-setup",
  "ls disk-usage-monitor-service_v2",
  "git checkout fix/task-panel-dismiss-manual-exit",
  "API_KEY = process.env.OPENAI_API_KEY_VALUE",
  "OPENAI_API_KEY=your-api-key-here-xxxx",
  "GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}",
  "MAX_TOKEN=4096",
  "export const PROMPT_TOKEN_BUDGET = computeBudget(model)",
];

describe("P1-1 私钥整块脱敏", () => {
  for (const kind of ["", "RSA ", "EC ", "OPENSSH ", "ENCRYPTED "]) {
    test(`完整 PEM（${kind || "无类型"}）：正文与 END 行都不残留`, () => {
      const out = maskSensitiveData(`before\n${pem(kind)}\nafter`);
      expect(out).not.toContain(PEM_BODY);
      expect(out).not.toContain("END");
      expect(out).toContain(`<PEM ${kind}PRIVATE KEY:`);
      expect(out.startsWith("before\n")).toBe(true);
      expect(out.endsWith("\nafter")).toBe(true);
    });
  }

  test("截断 PEM（只有 BEGIN 无 END）：正文遮到结尾", () => {
    const out = maskSensitiveData(pem("RSA ", false));
    expect(out).not.toContain(PEM_BODY);
    expect(out).toMatch(/^<PEM RSA PRIVATE KEY:\d+B>$/);
  });

  test("JSON.stringify 文本里的字面 \\n（warn.log 形态）同样整块遮", () => {
    const literal = JSON.stringify({ out: pem("OPENSSH ") });
    expect(literal).toContain("\\n");
    const out = maskSensitiveData(literal);
    expect(out).not.toContain(PEM_BODY);
    expect(out).not.toContain("END OPENSSH");
  });

  test("结构化路径：PEM 遮掉后 JSON 仍可解析、数字不动", () => {
    const j = JSON.stringify({ msg: pem("OPENSSH "), total_cost_usd: 0.4428123456780257 });
    const parsed = JSON.parse(maskSensitiveJson(j));
    expect(parsed.total_cost_usd).toBe(0.4428123456780257);
    expect(parsed.msg).toMatch(/^<PEM OPENSSH PRIVATE KEY:\d+B>$/);
  });

  test("正文里撞上短规则（AKIA…）时不产生交叉替换乱码", () => {
    const k = `-----BEGIN PRIVATE KEY-----\nAKIA${"ABCDEFGHIJKLMNOP"}xyz\n-----END PRIVATE KEY-----`;
    expect(maskSensitiveData(`x ${k} y`)).toMatch(/^x <PEM PRIVATE KEY:\d+B> y$/);
  });
});

describe("P1-2 sk- 显式前缀 + 左边界、github_pat_", () => {
  test.each([
    ["sk-proj-", SK_PROJ],
    ["sk-svcacct-", SK_SVCACCT],
    ["sk- 通用", SK_PLAIN],
    ["github_pat_", GH_PAT],
  ])("%s 被遮", (_label, key) => {
    const out = maskSensitiveData(`key is ${key} end`);
    expect(out).not.toContain(key);
    expect(out).toContain("****");
  });

  test("左边界：task-/disk-/mask- 前缀不触发 sk- 规则", () => {
    const s = `cd task-${ALNUM} && ls disk-${ALNUM}`;
    expect(maskSensitiveData(s)).toBe(s);
  });
});

describe("P1-3 赋值写法与 x-api-key 文本头", () => {
  test.each([
    `ANTHROPIC_API_KEY=${API_VALUE}`,
    `export MY_SERVICE_TOKEN=${API_VALUE}`,
    `OPENAI_API_KEY="${API_VALUE}"`,
    `{"DEEPSEEK_API_KEY": "${API_VALUE}"}`,
    `APP_SECRET: ${API_VALUE}`,
    `curl -H "x-api-key: ${API_VALUE}" https://example.invalid`,
  ])("值被遮、键名保留：%s", (s) => {
    const out = maskSensitiveData(s);
    expect(out).not.toContain(API_VALUE);
    const key = s.match(/[A-Za-z_-]*(?:KEY|TOKEN|SECRET|key)/)![0];
    expect(out).toContain(key);
  });
});

describe("误伤反例：新规则不得改写", () => {
  test.each(FALSE_POSITIVES)("%s", (s) => {
    expect(maskSensitiveData(s)).toBe(s);
  });

  test("AWS 官方示例 key 维持现有行为（被遮，见方案 §8.2）", () => {
    expect(maskSensitiveData("key = AKIAIOSFODNN7EXAMPLE")).toBe("key = AKIA********MPLE");
  });
});

describe("P1-5 maskJsonSafe fail-closed（字段级）", () => {
  const boom = (s: string): string => {
    if (s.includes("SECRET-PAYLOAD")) throw new Error("injected");
    return maskSensitiveData(s);
  };

  test("单个字段脱敏抛错：只替换该字段，其余照常，绝不回落原文", () => {
    const line = JSON.stringify({
      tool_use_id: "toolu_01",
      usage: { input_tokens: 12, output_tokens: 3 },
      bad: "SECRET-PAYLOAD " + SK_PLAIN,
      ok: "fine",
    });
    const out = maskJsonSafe(line, 0, "raw.jsonl", boom);
    expect(out).not.toContain(SK_PLAIN);
    const parsed = JSON.parse(out);
    expect(parsed.bad).toBe(REDACTION_FAILED_PLACEHOLDER);
    expect(parsed.ok).toBe("fine");
    expect(parsed.tool_use_id).toBe("toolu_01");
    expect(parsed.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
  });

  test("变异自证：恢复旧的「出错回落原文」语义，上面的断言必须失败", () => {
    // 旧实现的等价物：masker 抛错时直接返回 content
    const failOpen = (content: string): string => {
      try {
        return maskSensitiveJson(content, 0, undefined, boom);
      } catch {
        return content;
      }
    };
    const line = JSON.stringify({ bad: "SECRET-PAYLOAD " + SK_PLAIN });
    expect(failOpen(line)).toContain(SK_PLAIN);
    expect(maskJsonSafe(line, 0, "x", boom)).not.toContain(SK_PLAIN);
  });

  test("输入不是 JSON 时整条换成占位，不落原文", () => {
    const out = maskJsonSafe(`not json ${SK_PLAIN}`, 0, "raw.jsonl", () => {
      throw new Error("x");
    });
    expect(out).not.toContain(SK_PLAIN);
    expect(JSON.parse(out).redaction_failed).toBe(true);
  });
});

describe("P1-4 旁路落盘脱敏", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sid-pr-b-sink-"));
  });
  afterEach(() => {
    getLogger().setSessionWarnLogPath(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  test("warn.log：message 与 data 都脱敏（含 PEM 的 JSON 形态）", async () => {
    const lg = initLogger({
      enabled: true,
      level: LogLevel.WARN,
      logFile: join(dir, "debug.log"),
      console: false,
      fileOnly: true,
      append: true,
    });
    const warnLog = join(dir, "warn.log");
    lg.setSessionWarnLogPath(warnLog);
    lg.warn("TEST", `key in message ${SK_PROJ}`, { out: pem("RSA "), tok: GH_PAT });
    await lg.flush();
    const txt = readFileSync(warnLog, "utf-8");
    expect(txt).toContain("key in message");
    for (const secret of [SK_PROJ, GH_PAT, PEM_BODY]) expect(txt).not.toContain(secret);
  });

  test("protocol-violations/*.json：context_window 文本脱敏，仍是合法 JSON", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: `my key ${SK_PLAIN}` }] },
      { role: "assistant", content: [{ type: "tool_use", id: "x1", name: "bash", input: {} }] },
    ];
    const result = checkMessageHistoryIntegrity(messages);
    const path = dumpProtocolViolation(messages, result, {
      providerName: "openai",
      dumpDir: dir,
      now: 1700000000000,
    });
    expect(path).not.toBeNull();
    const txt = readFileSync(path!, "utf-8");
    expect(txt).not.toContain(SK_PLAIN);
    const snap = JSON.parse(txt);
    expect(snap.total_messages).toBe(2);
    expect(readdirSync(dir)).toHaveLength(1);
  });
});

describe("P1-7 / P1-8 家目录前缀替换", () => {
  test("替换前缀、保留相对结构，覆盖 JSON 转义的 Windows 形态", () => {
    expect(redactHomeDir('{"working_directory":"/Users/alice/proj/a"}', "/Users/alice")).toBe(
      '{"working_directory":"~/proj/a"}',
    );
    expect(redactHomeDir("cwd=/Users/alice", "/Users/alice")).toBe("cwd=~");
    const winJson = JSON.stringify({ cwd: "C:\\Users\\bob\\repo" });
    expect(redactHomeDir(winJson, "C:\\Users\\bob")).toBe(JSON.stringify({ cwd: "~\\repo" }));
  });

  test("边界：同名前缀的其它目录、嵌在更长路径里的片段不改", () => {
    const s = "/Users/alice2/x /data/Users/alice/y";
    expect(redactHomeDir(s, "/Users/alice")).toBe(s);
  });

  test("过短的家目录（/）不做替换", () => {
    expect(redactHomeDir("/etc/hosts", "/")).toBe("/etc/hosts");
  });

  test("UploadManager：redactHomeDir=true 时外发字节不含家目录，本地文件不变；默认关", async () => {
    const out = mkdtempSync(join(tmpdir(), "sid-pr-b-up-"));
    const sess = join(out, "s1");
    mkdirSync(sess, { recursive: true });
    const file = join(sess, "session.traj");
    const local = JSON.stringify({ working_directory: join(homedir(), "proj") });
    writeFileSync(file, local);

    const sent: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const blob = (await parseUploadBody(init)).get("file") as Blob;
      sent.push(await blob.text());
      return new Response(JSON.stringify({ status: "saved", sha256: "" }), { status: 200 });
    }) as any;
    try {
      const base = { baseUrl: "http://localhost", token: "t", outputDir: out, maxRetries: 1 };
      await new UploadManager({
        ...base,
        compress: false,
        redactHomeDir: true,
      }).uploadFileWithRetry(file, "s1", "traj");
      await new UploadManager({ ...base, compress: false }).uploadFileWithRetry(file, "s1", "traj");
    } finally {
      globalThis.fetch = origFetch;
      rmSync(out, { recursive: true, force: true });
    }
    expect(sent[0]).toBe(JSON.stringify({ working_directory: "~/proj" }));
    expect(sent[1]).toBe(local); // 默认关：原样
  });

  test("OTLP 根 span 的 cwd 走同一开关（源码接线）", async () => {
    const src = await Bun.file(join(import.meta.dir, "../../src/telemetry/hook-probe.ts")).text();
    expect(src).toContain("this.config.redactHomeDir");
    expect(src).toContain("redactHomeDir(input.cwd)");
    const init = await Bun.file(join(import.meta.dir, "../../src/query/init-helpers.ts")).text();
    expect(init).toContain("redactHomeDir: config.trace?.upload?.redactHomeDir");
  });
});

describe("P1-9 env / printenv 转储需确认", () => {
  let cfg: string;
  let ws: string;
  let prev: string | undefined;
  beforeEach(() => {
    cfg = mkdtempSync(join(tmpdir(), "sid-pr-b-cfg-"));
    ws = mkdtempSync(join(tmpdir(), "sid-pr-b-ws-"));
    prev = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = cfg;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prev;
    rmSync(cfg, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });
  const check = (command: string) =>
    new PermissionChecker({ ...defaultConfig() }, undefined, ws).check({
      toolName: "bash",
      input: { command },
    });

  test.each(["env", "env -0", "printenv", "printenv OPENAI_API_KEY", "env | grep KEY"])(
    "%s → 需确认（转储环境变量）",
    async (command) => {
      const r = await check(command);
      expect(r.allowed).toBe(false);
      expect(r.needsConfirmation).toBe(true);
      expect(r.reason).toContain("转储环境变量");
    },
  );

  test("env FOO=1 cmd（设变量再执行）不按转储拦", async () => {
    const r = await check("env FOO=1 true");
    expect(r.reason ?? "").not.toContain("转储环境变量");
  });
});

/**
 * §8.4 CI 层门禁：合成轨迹样例上，评测白名单字段逐字节不变、误伤反例不被改写、真凭证被遮。
 * 本机层（真实轨迹批量对比 + 命中直方图）不进 CI，结果写在 PR 描述里。
 */
describe("§8.4 评测字段不变门禁（合成样例）", () => {
  const WHITELIST = [
    "usage",
    "total_cost_usd",
    "stop_reason",
    "exit_status",
    "model",
    "timestamp",
    "step",
    "tool_name",
    "tool_use_id",
    "is_error",
    "session_id",
  ] as const;

  /** 合成 raw.jsonl 风格的行：白名单字段 + 误伤反例写进 command / file_path + 真凭证写进输出 */
  function syntheticLines(): string[] {
    return FALSE_POSITIVES.map((cmd, i) =>
      JSON.stringify({
        session_id: "20261013-120000-abcdef12",
        timestamp: "2026-10-13T12:00:00.000Z",
        model: "deepseek-v4-pro",
        step: i,
        tool_name: "bash",
        tool_use_id: `toolu_01${ALNUM}${i}`,
        is_error: false,
        stop_reason: "tool_use",
        exit_status: "end_turn",
        total_cost_usd: 0.4428123456780257,
        usage: { input_tokens: 4096, output_tokens: 128, cache_read_input_tokens: 3900 },
        tool_input: { command: cmd, file_path: "tasks/task-qemu-alpine-ssh-key-setup/a.sh" },
        tool_output: `OPENAI_API_KEY=${API_VALUE}\n${SK_PROJ}\n${GH_PAT}\n${pem("RSA ", false)}`,
      }),
    );
  }

  /** 返回违反项；空数组 = 门禁通过 */
  function gate(masker: (s: string) => string): string[] {
    const bad: string[] = [];
    for (const line of syntheticLines()) {
      const before = JSON.parse(line);
      const after = JSON.parse(maskSensitiveJson(line, 0, undefined, masker));
      for (const k of WHITELIST) {
        if (JSON.stringify(before[k]) !== JSON.stringify(after[k]))
          bad.push(`白名单字段变化: ${k}`);
      }
      if (JSON.stringify(before.tool_input) !== JSON.stringify(after.tool_input)) {
        bad.push(`误伤: ${before.tool_input.command}`);
      }
      for (const secret of [API_VALUE, SK_PROJ, GH_PAT, PEM_BODY]) {
        if (after.tool_output.includes(secret)) bad.push(`漏网: ${secret.slice(0, 12)}`);
      }
    }
    return bad;
  }

  test("现行规则：门禁通过", () => {
    expect(gate(maskSensitiveData)).toEqual([]);
  });

  test("变异自证：加一条会命中 tool_use_id 的规则 → 门禁变红", () => {
    const mutant = (s: string) => maskSensitiveData(s).replace(/toolu_\w+/g, "toolu_****");
    expect(gate(mutant).some((x) => x.includes("tool_use_id"))).toBe(true);
  });

  test("变异自证：放宽 sk- 字符类（旧方案）→ 门禁报误伤", () => {
    const loose = (s: string) =>
      maskSensitiveData(s).replace(/sk-[A-Za-z0-9_-]{20,}/g, (m) => m.slice(0, 3) + "****");
    expect(gate(loose).some((x) => x.startsWith("误伤"))).toBe(true);
  });

  test("变异自证：去掉脱敏 → 门禁报漏网", () => {
    expect(gate((s) => s).some((x) => x.startsWith("漏网"))).toBe(true);
  });
});
