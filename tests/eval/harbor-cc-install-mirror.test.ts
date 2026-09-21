/**
 * D2（cc 安装走宿主镜像）+ D3（mem.log 追加写）静态门禁
 *
 * ## 为什么必须有
 *
 * A3 开跑 25 分钟模型 0 次调用：每题 curl nodejs.org + npm registry，
 * `-n 6` 带宽争抢出 curl 18/56；另一条独立失败是平台 optional dep
 * 没下到 → `claude native binary not installed`（08a §3.7）。
 *
 * 失效形态全都不报错、token 空、被 classify 删后重跑 —— 分数看起来正常，
 * 墙钟被安装失败拉长。下次 `SID_W3_ARM=cc` 之前这一层必须先绿。
 *
 * ## 为什么只有 L1
 *
 * 不起容器、不联网、不跑 harbor。CI 上真的在跑。
 * 真实生效靠 `lib/cc-install-mirror.sh start` 自己的：
 * packument tarball 改写探针 + 容器可达性闸。
 *
 * ## 判据读代码不读注释
 *
 * 注释里必然出现 `nodejs.org` / `native binary` / `>>`，读全文会绿着失效。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const HARBOR = join(import.meta.dir, "../../evals/external-benchmarks/harbor");
const LIB = join(import.meta.dir, "../../evals/external-benchmarks/lib");
const RESULTS = join(HARBOR, "results");

const CC_RUNNER = join(HARBOR, "run-claude-code-contrast.sh");
const SID_RUNNER = join(HARBOR, "run-model-switch.sh");
const AGENT = join(HARBOR, "claude_code_agent.py");
const MIRROR_SH = join(LIB, "cc-install-mirror.sh");
const MIRROR_PY = join(LIB, "cc-install-mirror-server.py");
const SUMMARY = join(HARBOR, "w3-summary.py");

const read = (p: string) => readFileSync(p, "utf8");
const codeOf = (p: string) =>
  read(p)
    .split("\n")
    .filter((l) => !/^\s*#/.test(l) && !/^\s*\/\//.test(l))
    .join("\n");

describe("D2 脚本存在且不走 python -m http.server", () => {
  test("lib/cc-install-mirror.sh 与 server.py 存在", () => {
    expect(existsSync(MIRROR_SH)).toBe(true);
    expect(existsSync(MIRROR_PY)).toBe(true);
  });

  test("不用 python3 -m http.server（getfqdn(0.0.0.0) 在本机 128s）", () => {
    // 判据在启动命令，不在文档字符串（server.py 模块头会提到这个禁令）。
    expect(codeOf(MIRROR_SH)).not.toMatch(/python3\s+-m\s+http\.server/);
    expect(codeOf(MIRROR_PY)).toContain("FastBindHTTPServer");
    expect(codeOf(MIRROR_PY)).toMatch(/FastBindHTTPServer\(\("0\.0\.0\.0"/);
  });

  test("宿主地址默认是 colima host-gateway 192.168.5.2", () => {
    expect(codeOf(MIRROR_SH)).toContain("192.168.5.2");
    expect(codeOf(MIRROR_SH)).not.toMatch(
      /^\s*HOST_ADDR="\$\{SID_CC_MIRROR_HOST:-host\.docker\.internal\}"/m,
    );
  });

  test("平台包与主包一起托（linux-x64 + musl）", () => {
    const s = codeOf(MIRROR_SH);
    expect(s).toContain("@anthropic-ai/claude-code-linux-x64");
    expect(s).toContain("@anthropic-ai/claude-code-linux-x64-musl");
  });

  test("rewrite_tarball 把 registry.npmjs.org 换成镜像 URL（摘掉必须红）", () => {
    const snippet = `
import json, sys
sys.path.insert(0, ${JSON.stringify(LIB)})
from importlib.machinery import SourceFileLoader
m = SourceFileLoader("ccms", ${JSON.stringify(MIRROR_PY)}).load_module()
doc = {
  "name": "@anthropic-ai/claude-code-linux-x64",
  "version": "2.1.252",
  "dist": {"tarball": "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.252.tgz"},
}
out = m.rewrite_tarball(doc, "http://192.168.5.2:18078", doc["name"])
print(out["dist"]["tarball"])
`;
    const r = Bun.spawnSync({
      cmd: ["python3", "-c", snippet],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode ?? 1, r.stderr.toString()).toBe(0);
    const url = r.stdout.toString().trim();
    expect(url).toContain("http://192.168.5.2:18078/npm/");
    expect(url).not.toContain("registry.npmjs.org");
  });

  test("容器侧可达性是独立一闸", () => {
    expect(codeOf(MIRROR_SH)).toMatch(/docker run[\s\S]*?http_code/);
  });
});

describe("D2 必须进 agent 容器（--ae 不是 --ve）", () => {
  test("cc runner 调用 cc-install-mirror.sh start", () => {
    expect(codeOf(CC_RUNNER)).toMatch(/cc-install-mirror\.sh\s+start/);
  });

  test("注入是 --ae SID_CC_NODE_MIRROR 与 --ae SID_CC_NPM_REGISTRY", () => {
    const code = codeOf(CC_RUNNER);
    expect(code).toMatch(/--ae\s+"SID_CC_NODE_MIRROR=/);
    expect(code).toMatch(/--ae\s+"SID_CC_NPM_REGISTRY=/);
    // --ve 进 verifier，agent 安装读不到。写成 --ve 就是白做。
    const aeBlock = code.slice(code.indexOf("cc-install-mirror"));
    expect(aeBlock).not.toMatch(/--ve\s+"SID_CC_NODE_MIRROR=/);
  });

  test("跳过开关 SID_HARBOR_SKIP_CC_MIRROR 存在且失败不静默", () => {
    expect(codeOf(CC_RUNNER)).toContain("SID_HARBOR_SKIP_CC_MIRROR");
    const s = read(CC_RUNNER);
    expect(s).toMatch(/cc 安装镜像未起成|退回直连/);
  });

  test("claude_code_agent.py 读 SID_CC_NODE_MIRROR / SID_CC_NPM_REGISTRY", () => {
    const code = codeOf(AGENT);
    expect(code).toContain("SID_CC_NODE_MIRROR");
    expect(code).toContain("SID_CC_NPM_REGISTRY");
    expect(code).toContain("--registry");
  });

  test("没注入镜像时仍保留 nodejs.org 直连（退回不更坏）", () => {
    // 这条刻意读全文：直连 URL 允许只出现在 else 分支。
    expect(read(AGENT)).toContain("nodejs.org/dist");
  });
});

describe("D3 mem.log 追加写，resume 不丢上一轮", () => {
  for (const [name, path] of [
    ["cc", CC_RUNNER],
    ["sid", SID_RUNNER],
  ] as const) {
    test(`${name} 臂用 >> 而不是 > 覆盖`, () => {
      const code = codeOf(path);
      expect(code).toMatch(/>>\s+"\$MEM_LOG"/);
      // 无条件覆盖写必须不在代码路径上。注释里会提到旧写法。
      expect(code).not.toMatch(/\)\s*>\s+"\$MEM_LOG"/);
    });

    test(`${name} 臂行首打 ROUND`, () => {
      expect(codeOf(path)).toMatch(/ROUND/);
    });
  }
});

describe("E1 历史分母披露已落进归档", () => {
  const files = [
    "w3-sid-sonnet-66.json",
    "w3-cc-sonnet-54.json",
    "w3-sid-ds41-54.json",
    "w3-sid-sonnet-66__w3-cc-sonnet-54.json",
  ];

  test("sensitivity JSON 存在且 n=48 方向反", () => {
    const p = join(RESULTS, "sensitivity-exam-zeros-2026-09-20.json");
    expect(existsSync(p)).toBe(true);
    const d = JSON.parse(read(p)) as {
      official: { n: number; sid_passed: number; cc_passed: number };
      without_exam_zeros: { n: number; sid_passed: number; cc_passed: number };
    };
    expect(d.official.n).toBe(54);
    expect(d.official.sid_passed).toBe(25);
    expect(d.official.cc_passed).toBe(27);
    expect(d.without_exam_zeros.n).toBe(48);
    expect(d.without_exam_zeros.sid_passed).toBe(25);
    expect(d.without_exam_zeros.cc_passed).toBe(23);
  });

  for (const name of files) {
    test(`${name} caveats 含「当时分母掺了」且 scored 仍是 54`, () => {
      const d = JSON.parse(read(join(RESULTS, name))) as {
        arms: Array<{
          arm: string;
          denominators: { scored: number };
          ci: { passed: number };
          caveats: string[];
        }>;
      };
      expect(d.arms[0].denominators.scored).toBe(54);
      const blob = d.arms.map((a) => a.caveats.join("\n")).join("\n");
      expect(blob).toContain("当时分母掺了");
    });
  }

  test("w3-summary.py 默认拒绝覆盖含该 caveat 的归档", () => {
    const code = codeOf(SUMMARY);
    expect(code).toContain("_existing_archive_has_exam_caveat");
    expect(code).toContain("当时分母掺了");
    expect(code).toContain("--force");
  });
});
