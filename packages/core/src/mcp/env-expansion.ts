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

/**
 * 对配置对象中的所有字符串值进行环境变量展开
 */
export function expandConfigEnvVars(config: {
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}): { missing: string[] } {
  const allMissing: string[] = [];

  if (config.command) {
    const { expanded, missing } = expandEnvVars(config.command);
    config.command = expanded;
    allMissing.push(...missing);
  }

  if (config.args) {
    config.args = config.args.map((arg) => {
      const { expanded, missing } = expandEnvVars(arg);
      allMissing.push(...missing);
      return expanded;
    });
  }

  if (config.url) {
    const { expanded, missing } = expandEnvVars(config.url);
    config.url = expanded;
    allMissing.push(...missing);
  }

  if (config.headers) {
    for (const [key, val] of Object.entries(config.headers)) {
      const { expanded, missing } = expandEnvVars(val);
      config.headers[key] = expanded;
      allMissing.push(...missing);
    }
  }

  return { missing: allMissing };
}
