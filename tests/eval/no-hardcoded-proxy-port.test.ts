/**
 * 代理端口不许写死 —— 覆盖 `evals/external-benchmarks/` 下的评测脚本
 *
 * ## 这份测试为什么必须存在
 *
 * 2026-08-31 一天之内，**三个互相独立的写死点同时失效**：飞鸟云（FlClash）
 * 重启后把本地代理口从 `7881` 换成了 `7890`，而三处都把 `7881` 写死在配置里。
 * 关键在于**没有任何一处的报错提到「端口变了」**：
 *
 * | 写死点 | 症状 | 会把人引向 |
 * | --- | --- | --- |
 * | `~/.gitconfig` 的 github proxy | `Failed to connect to 127.0.0.1 port 7881 after 0 ms` | 网络 / 墙 |
 * | `~/.local/bin/gh` wrapper | `gh auth status` 报 **The token in keyring is invalid** | **去刷 token（白折腾）** |
 * | VM 内 dockerd 的 systemd drop-in | `proxyconnect tcp: dial tcp 192.168.5.2:7881: refused` | registry / 镜像源 |
 *
 * 第二个最坑：它把**基础设施故障翻译成了凭据故障**。实测 `NO_PROXY='*' gh auth status`
 * 立刻通过、scopes 齐全 —— token 一直是好的。
 *
 * 这正是本仓「报错指向错误方向」那一类，而它的成本是每次复发都要重查一遍全链路。
 * 所以把「端口必须探测」变成一条会**在 CI 上真的跑**的门禁。
 *
 * ## 判据：为什么不是「grep 到数字就报错」
 *
 * 端口数字本身不是错误 —— 有两类**正当**的写死，判据必须放过它们，否则门禁会
 * 逼着人去改对的代码（`evals/CLAUDE.md` §1.3：判据错了的门禁会主动阻止修复）：
 *
 *   1. **自有服务的监听口**：`net-setup.sh` 的 `PROXY_PORT=8080` 是它自己
 *      `echo "Port $PROXY_PORT"` 写进 tinyproxy 配置的 —— 生产者和消费者都是这个脚本，
 *      不存在「别人换了口」的可能。
 *   2. **默认值 + 环境变量覆写**：`${SID_HARBOR_GATEWAY_PORT:-4100}` 这种形态，
 *      人能在不改代码的前提下拨正。
 *
 * 真正要拦的是**第三方软件的端口被硬编码进配置字符串**，也就是
 * `http://<host>:<port>` 里的 port 既不来自探测、也不来自环境变量。
 *
 * ## 变异自证（`CLAUDE.md`：新增门禁必做变异自证）
 *
 * 每组断言都配反向用例：在 tmpdir 的 fixture 上人为写坏，判定必须翻转。
 * 只断言 happy path 的测试无法区分「逻辑对」与「checker 恒返 ok」——
 * 本仓已有过「静态扫描抓不到间接落盘」「探针形态不等于真实流量」两次假绿教训。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const BENCH_DIR = join(REPO_ROOT, "evals", "external-benchmarks");

/** 被扫描的脚本。只列**会连第三方代理**的，自有服务监听口不在此列。 */
const SCANNED_FILES: string[] = [
  "swe-bench/setup-env.sh",
  "harbor/run-permission-switch.sh",
  "harbor/sid_code_agent.py",
];

/**
 * 自有服务的监听口白名单 —— 这些端口**由本仓自己的脚本决定**，不是第三方软件的口。
 *
 * `8080` = `net-setup.sh` 里 tinyproxy 的监听口，由同一个脚本
 * `echo "Port $PROXY_PORT"` 写进配置：生产者和消费者都是我们，
 * 不存在「别人换了口」这种失效路径。判据按**端口归属**放行，而不是靠
 * 「这一行有没有变量」—— 后者会把 usage 提示误报成缺陷
 *（本门禁初版就误报了 `setup-env.sh` 打印 preflight 用法的那一行）。
 */
const SELF_OWNED_PORTS = new Set(["8080"]);

/**
 * 找出「写死了第三方代理端口」的行。
 *
 * 判据是 `http://<host>:<纯数字>`，且该行**没有**任何一个脱困出口：
 *   - `${VAR}` / `$VAR`（环境变量或探测结果）
 *   - `:-`（shell 默认值展开，即 `${VAR:-4100}`）
 *   - `{`（Python f-string 插值，即 `f"...:{PORT}"`）
 *
 * ⚠️ 注释行不放过：写死的端口写在注释里同样会被人照抄
 *（那三处失效点里就有两处是照着注释/文档抄的）。但**教训叙述**需要引用旧端口，
 * 所以带 `教训` / `实测` / `症状` / `原是` 字样的行豁免 —— 它们是病历，不是配方。
 */
function findHardcodedProxyPorts(content: string): { line: number; text: string }[] {
  const hits: { line: number; text: string }[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // 只看 http(s)://host:port 形态；host 不含 `/` 以避免匹配路径
    const m = line.match(/https?:\/\/[^\s/"'`]+:(\d{2,5})\b/);
    if (!m) continue;

    // 自有服务的监听口：端口归属决定放行，与这一行有没有变量无关
    if (SELF_OWNED_PORTS.has(m[1]!)) continue;

    // 脱困出口：这一行用了变量/默认值/插值 ⇒ 端口不是写死的
    if (/\$\{|\$[A-Za-z_]|:-|\{[A-Za-z_]/.test(line)) continue;

    // 病历豁免：教训叙述必须能引用旧端口
    if (/教训|实测|症状|原是|曾经|历史值|白折腾/.test(line)) continue;

    hits.push({ line: i + 1, text: line.trim() });
  }
  return hits;
}

describe("代理端口不许写死", () => {
  test.each(SCANNED_FILES)("%s 不含写死的第三方代理端口", (rel: string) => {
    const content = readFileSync(join(BENCH_DIR, rel), "utf8");
    const hits = findHardcodedProxyPorts(content);
    expect(
      hits,
      hits.length === 0
        ? ""
        : `写死了第三方代理端口（飞鸟云换口后必然失效，且报错不会提端口）：\n` +
            hits.map((h) => `  ${rel}:${h.line}  ${h.text}`).join("\n") +
            `\n改法：端口从 lib/detect-proxy-port.sh 探测，或用 \${VAR:-默认值} 留出覆写口`,
    ).toEqual([]);
  });

  test("探测器存在且四条判据齐全", () => {
    const detector = readFileSync(join(BENCH_DIR, "lib", "detect-proxy-port.sh"), "utf8");
    // 判据 1：显式指定；2：scutil 系统代理；3：备选表；4：探不到不猜
    expect(detector).toContain("SID_PROXY_PORT");
    expect(detector).toContain("scutil");
    expect(detector).toContain("DETECT_FALLBACK_PORTS");
    // 探活必须用 CONNECT 实证 —— `nc -z` 双向都会骗人（假阴性 + DNS 污染下的假阳性）
    expect(detector).toContain("curl");
    expect(detector).not.toMatch(/^\s*nc -z/m);
  });

  test("setup-env.sh 的 dockerd 代理步骤经由探测器，而非写死", () => {
    const setup = readFileSync(join(BENCH_DIR, "swe-bench", "setup-env.sh"), "utf8");
    expect(setup).toContain("detect-proxy-port.sh");
    expect(setup).toContain("detect_proxy_port");
    // 探不到时必须拒绝写配置 —— 猜一个端口只会把故障挪进 docker pull
    expect(setup).toMatch(/没有可用 HTTP 代理/);
  });

  test("网关默认端口与 shim 的 --port 默认值一致（4000 是透传代理，指错会报 401）", () => {
    const agent = readFileSync(join(BENCH_DIR, "harbor", "sid_code_agent.py"), "utf8");
    const m = agent.match(/DEFAULT_GATEWAY_PORT\s*=\s*(\d+)/);
    expect(m, "缺少 DEFAULT_GATEWAY_PORT 常量").not.toBeNull();
    expect(Number(m![1])).toBe(4100);
    // 默认 URL 必须由该常量插值得来，不能再各写一遍数字
    expect(agent).toMatch(/DEFAULT_GATEWAY_URL\s*=\s*f".*\{DEFAULT_GATEWAY_PORT\}/);
  });

  test("闸 3 验的是网关身份的结构，不是状态码（透传代理的 /__stats 回 200 HTML）", () => {
    const run = readFileSync(join(BENCH_DIR, "harbor", "run-permission-switch.sh"), "utf8");
    expect(run).toContain("preflight_gateway_identity");
    // 必须解析 JSON 结构；只看 http_code 会被 claude-trace 的 200 HTML 骗过
    expect(run).toContain("upstream_model");
    expect(run).toMatch(/elif ! preflight_gateway_identity; then\n\s*exit 1/);
  });
});

describe("变异自证：判据必须能翻转", () => {
  const fixture = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "proxy-port-gate-"));
    const p = join(dir, "f.sh");
    writeFileSync(p, content);
    return p;
  };

  test("写死端口 → 必须命中", () => {
    const p = fixture("export URL=http://192.168.5.2:7881\n");
    expect(findHardcodedProxyPorts(readFileSync(p, "utf8"))).toHaveLength(1);
  });

  test("环境变量覆写形态 → 必须放过", () => {
    const p = fixture('export URL="http://192.168.5.2:${SID_HARBOR_GATEWAY_PORT:-4100}"\n');
    expect(findHardcodedProxyPorts(readFileSync(p, "utf8"))).toHaveLength(0);
  });

  test("探测结果插值 → 必须放过", () => {
    const p = fixture('WANT="http://192.168.5.2:${HOST_PROXY_PORT}"\n');
    expect(findHardcodedProxyPorts(readFileSync(p, "utf8"))).toHaveLength(0);
  });

  test("Python f-string 插值 → 必须放过", () => {
    const p = fixture('U = f"http://host.docker.internal:{DEFAULT_GATEWAY_PORT}"\n');
    expect(findHardcodedProxyPorts(readFileSync(p, "utf8"))).toHaveLength(0);
  });

  test("教训叙述里引用旧端口 → 必须放过（病历不是配方）", () => {
    const p = fixture("# 2026-08-31 教训：写死 http://192.168.5.2:7881 导致全线失败\n");
    expect(findHardcodedProxyPorts(readFileSync(p, "utf8"))).toHaveLength(0);
  });

  test("普通 URL 不含端口 → 不误报", () => {
    const p = fixture("curl https://registry-1.docker.io/v2/\n");
    expect(findHardcodedProxyPorts(readFileSync(p, "utf8"))).toHaveLength(0);
  });

  test("自有服务监听口不在扫描名单内（net-setup.sh 的 8080 是它自己写的）", () => {
    // 判据在名单，不在正则：这条锁的是「名单没被人顺手扩大到误伤自有服务」
    expect(SCANNED_FILES).not.toContain("swe-bench/net-setup.sh");
  });

  test("自有服务端口即使写死也放过（8080 归属本仓，不会被第三方换掉）", () => {
    const p = fixture('echo "    --proxy http://127.0.0.1:8080"\n');
    expect(findHardcodedProxyPorts(readFileSync(p, "utf8"))).toHaveLength(0);
  });

  test("白名单不能宽到放过第三方口（7890 必须仍被拦）", () => {
    // 反向锁：确认 SELF_OWNED_PORTS 没被人顺手加成「所有端口都放行」
    const p = fixture("export URL=http://127.0.0.1:7890\n");
    expect(findHardcodedProxyPorts(readFileSync(p, "utf8"))).toHaveLength(1);
  });
});
