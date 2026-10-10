/**
 * MCP 环境变量模板展开
 * 支持 ${VAR} 和 ${VAR:-default} 语法
 */

export function expandEnvVars(value: string): { expanded: string; missing: string[] } {
  const missing: string[] = [];
  const expanded = value.replace(/\$\{([^}]+)\}/g, (_match, content) => {
    const [varName, defaultValue] = content.split(":-", 2);
    const envValue = process.env[varName];
    if (envValue !== undefined) return envValue;
    if (defaultValue !== undefined) return defaultValue;
    missing.push(varName);
    return _match;
  });
  return { expanded, missing };
}

/** 参与变量展开的配置字段（MCPServerConfig 的子集） */
export interface ExpandableMcpFields {
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

/**
 * 对配置里所有可能放 `${VAR}` 的字段做展开，返回**副本**（不改原配置）。
 *
 * D4：这是建连、策略过闸（policy.ts）、签名去重（config.ts）三处的**唯一**展开入口。
 * 原先 createTransport 只逐个展开了 command / args / url，`headers` 与 `env` 原样透传，
 * 而密钥最常出现的恰好就是这两个位置——症状是远端 401，排查时最后才会想到「变量没展开」。
 * 三处各展开各的，迟早又有一处漏掉某个字段，所以收成这一个函数。
 *
 * 不改原配置是刻意的：serverConfigs 里存的是模板原文，重连 / half-open 探测每次都重新展开，
 * 用户在会话中途改了环境变量（如刷新 token）下一次建连就能拿到新值。
 *
 * `env` 也展开：stdio 子进程本就继承整个 process.env，`${VAR}` 在 env 里的真正价值是
 * 「改名」（把 MY_API_KEY 喂成 Server 要的 API_KEY）。不展开时子进程收到的是字面量
 * `${MY_API_KEY}`，并且会**覆盖**继承来的同名真值——于是「有时能用、有时不能用」。
 */
export function expandConfigEnvVars<T extends ExpandableMcpFields>(
  config: T,
): { config: T; missing: string[] } {
  const allMissing: string[] = [];
  const one = (v: string): string => {
    const { expanded, missing } = expandEnvVars(v);
    allMissing.push(...missing);
    return expanded;
  };
  const record = (r: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, one(v)]));

  const out: T = { ...config };
  if (config.command !== undefined) out.command = one(config.command);
  if (config.args !== undefined) out.args = config.args.map(one);
  if (config.url !== undefined) out.url = one(config.url);
  if (config.headers !== undefined) out.headers = record(config.headers);
  if (config.env !== undefined) out.env = record(config.env);

  return { config: out, missing: allMissing };
}
