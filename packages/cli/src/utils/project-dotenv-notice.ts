/**
 * 运行目录 `.env` 不再被读取的提示（PR-A1 副作用的应对）
 *
 * 编译产物已用 `--no-compile-autoload-dotenv` 关掉运行目录 `.env` 的自动加载（防克隆仓库改道）。
 * 少数用户可能一直靠项目 `.env` 配 `SID_CODE_*` / `*_API_KEY`，升级后这些变量静默失效、
 * 表现为「key 不对 / 网关不对」，很难联想到原因。所以在 cwd 检测到这类键时提示一行。
 *
 * 三条约束（都是刻意的）：
 * - **只打印键名、绝不打印值**：值可能就是凭证；
 * - **走 stderr、不进 stdout**：headless 的 stdout 会被评测与脚本解析；
 * - **每个目录只提示一次**（记在 state/ 下），否则每次启动都刷一行，人会学会忽略它。
 *
 * 源码模式（`bun <entry>.ts`）下 bun 仍会加载 `.env`，此时提示「不再读取」是假话，调用方须跳过。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** bun 在编译产物里默认会读的三个文件（NODE_ENV 被 define 为 production）。 */
export const PROJECT_DOTENV_FILES = [".env", ".env.local", ".env.production"] as const;

/** 只关心会影响 sid-code 自身行为的键：自家前缀，以及各家模型的 API key。 */
const SENSITIVE_KEY = /^(?:SID_CODE_\w+|\w+_API_KEY)$/;
const ASSIGN_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

export interface DotenvHit {
  file: string;
  keys: string[];
}

/** 扫描 cwd 下的 .env 类文件，返回含敏感键的文件与键名（不含值）。读失败的文件跳过。 */
export function detectProjectDotenvKeys(cwd: string): DotenvHit[] {
  const hits: DotenvHit[] = [];
  for (const file of PROJECT_DOTENV_FILES) {
    const p = join(cwd, file);
    if (!existsSync(p)) continue;
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const keys = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(ASSIGN_LINE);
      if (m && SENSITIVE_KEY.test(m[1])) keys.add(m[1]);
    }
    if (keys.size > 0) hits.push({ file, keys: [...keys] });
  }
  return hits;
}

/** 组装提示文本（单行）。只含文件名与键名。 */
export function formatDotenvNotice(hits: DotenvHit[]): string {
  const detail = hits.map((h) => `${h.file}: ${h.keys.join(", ")}`).join("; ");
  return (
    `提示: sid-code 不再读取运行目录的 .env 文件（${detail}）。` +
    `如需这些变量，请在 shell 中 export，或写到 settings.json 的 env 字段。`
  );
}

/**
 * 检测并在需要时提示一次。返回是否打印了提示（供测试断言）。
 *
 * @param stateFile 记录「已提示过的目录」的 JSON 文件路径
 * @param write     输出函数，缺省写 stderr
 */
export function maybeNotifyProjectDotenv(
  cwd: string,
  stateFile: string,
  write: (s: string) => void = (s) => process.stderr.write(s),
): boolean {
  const hits = detectProjectDotenvKeys(cwd);
  if (hits.length === 0) return false;

  const dir = resolve(cwd);
  let seen: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    if (Array.isArray(parsed?.notified))
      seen = parsed.notified.filter((x: unknown) => typeof x === "string");
  } catch {
    // 文件不存在或损坏：当作没提示过
  }
  if (seen.includes(dir)) return false;

  write(formatDotenvNotice(hits) + "\n");
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    // 上限防无界增长：保留最近 500 个目录，超出后最旧的会再提示一次，代价可接受
    writeFileSync(stateFile, JSON.stringify({ notified: [...seen, dir].slice(-500) }, null, 2));
  } catch {
    // 记不住只会导致下次再提示一次，不影响启动
  }
  return true;
}
