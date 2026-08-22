/**
 * 端点归一化 — 计费复合键 `(model, endpoint)` 的端点侧稳定 key。
 *
 * 背景：同一模型名走不同端点（公司网关 vs 官方）价格不同，计费需按 (model, baseURL)
 * 复合键精确匹配。但 base_url 字面量有多种等价写法（末尾斜杠、协议/host 大小写），
 * 直接字符串比较会漏配。此函数把端点收敛成稳定 key 供比较。
 *
 * 设计原则（保守）：
 * - 去首尾空白、去末尾斜杠（`https://x/v1/` → `https://x/v1`）
 * - 协议与 host 小写（大小写不敏感），**路径大小写保留**
 * - **不剥 `/v1`**：Anthropic 端点不带 `/v1`、OpenAI 端点带 `/v1`，同一 host 上二者
 *   是不同部署，剥掉会把两个端点误并成一个 key（见 memory `gateway-baseurl-v1-path-rule`）
 * - 空 / undefined → `""`（= 官方默认端点，与「未配 baseURL」等价）
 *
 * 与 provider 缓存 key（registry.ts:49 的 `providerName:baseURL`）对齐：都以 baseURL
 * 作为端点区分维度，此处只是补上归一化避免字面量差异。
 */
export function normalizeBaseURL(baseURL?: string | null): string {
  if (!baseURL) return "";
  // 类型之外的防御：baseURL 的实际来源包括 settings.json / 网关采集缓存等**无类型保证**
  // 的通道，一个手写错的配置（数字、对象）会让 `.trim()` 抛 TypeError，
  // 而本函数在计价热路径上 —— 崩在这里等于整次计价失败。归一化为"无端点"是安全降级。
  if (typeof baseURL !== "string") return "";
  const trimmed = baseURL.trim();
  if (!trimmed) return "";

  try {
    const u = new URL(trimmed);
    // 协议 + host 小写；路径保留大小写但去末尾斜杠。
    const proto = u.protocol.toLowerCase();
    const host = u.host.toLowerCase();
    let path = u.pathname;
    if (path.endsWith("/")) path = path.slice(0, -1);
    // 去掉纯 "/" 路径（归一到无路径）
    if (path === "") return `${proto}//${host}`;
    return `${proto}//${host}${path}`;
  } catch {
    // 非法 URL（少见）：退化为「去空白 + 去末尾斜杠 + 整体小写」的 best-effort key。
    let s = trimmed.replace(/\/+$/, "");
    return s.toLowerCase();
  }
}

/** 两个 base_url 是否指向同一端点（归一化后相等）。 */
export function sameEndpoint(a?: string | null, b?: string | null): boolean {
  return normalizeBaseURL(a) === normalizeBaseURL(b);
}
