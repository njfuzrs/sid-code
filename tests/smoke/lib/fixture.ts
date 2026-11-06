/**
 * 回放夹具：占位符替换 + 路径越界校验。
 *
 * 回放的语义是「模型响应回放，工具真实执行」。录制里的工具入参带的是录制当时的绝对路径，
 * 原样回放会读写用例目录之外的文件（2026-11-06 探针实测：A2 录制里的
 * `/private/tmp/a2-e2e/hello.txt` 被真的 read 了）。所以夹具里一律写 `${CASE_ROOT}`，
 * 运行时替换成本次的临时目录；替换后**任何**以 `/` 开头的字符串都必须落在用例根目录内，
 * 否则拒绝执行。这条不靠作者自觉。
 */

export const CASE_ROOT_PLACEHOLDER = "${CASE_ROOT}";

/** 把夹具文本里的占位符替换成实际用例根目录。JSON 字符串内需要转义，故按 JSON 片段替换。 */
export function substituteCaseRoot(jsonl: string, caseRoot: string): string {
  const escaped = JSON.stringify(caseRoot).slice(1, -1);
  return jsonl.split(CASE_ROOT_PLACEHOLDER).join(escaped);
}

/** 递归收集值里所有以 `/` 开头的字符串（及其 JSON 路径），用于越界校验。 */
function collectAbsolutePaths(
  value: unknown,
  at: string,
  out: Array<{ at: string; path: string }>,
) {
  if (typeof value === "string") {
    if (value.startsWith("/")) out.push({ at, path: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectAbsolutePaths(v, `${at}[${i}]`, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) collectAbsolutePaths(v, `${at}.${k}`, out);
  }
}

/**
 * 校验替换后的夹具：每条 tool_use 入参里的绝对路径都必须在 `caseRoot` 内。
 * 返回违规列表（空数组 = 通过）。不可解析的行直接算违规——夹具是手写/录制后审过的，
 * 坏行说明夹具本身有问题，不能像 ReplayProvider 那样静默跳过。
 */
export function findOutOfRootPaths(jsonl: string, caseRoot: string): string[] {
  const root = caseRoot.endsWith("/") ? caseRoot : `${caseRoot}/`;
  const violations: string[] = [];
  jsonl.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      violations.push(`第 ${i + 1} 行不是合法 JSON`);
      return;
    }
    const content = obj?.response?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      const found: Array<{ at: string; path: string }> = [];
      collectAbsolutePaths(block.input, "input", found);
      for (const f of found) {
        if (f.path !== caseRoot && !f.path.startsWith(root)) {
          violations.push(`第 ${i + 1} 行 ${block.name}.${f.at} = ${f.path}（不在用例根目录内）`);
        }
      }
    }
  });
  return violations;
}
