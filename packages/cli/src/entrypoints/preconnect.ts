/**
 * API 预连接（对齐 Claude Code 的时间重叠优化）
 *
 * 在启动期、首次真正的 API 请求之前，提前建立 TCP + TLS 连接。
 * 握手（~100-200ms）与模块加载 / 配置读取在时间上重叠，
 * 首次请求时连接已就绪，省去握手延迟。
 *
 * 设计约束：
 * - fire-and-forget：不等待响应，错误静默忽略（预连接失败不影响主流程）
 * - 仅做 TCP/TLS 握手：发一个轻量 HEAD 请求即可触发连接建立，
 *   连接会被后续请求（HTTP keep-alive / HTTP2）复用
 * - 必须在 mTLS / proxy 配置生效之后调用，否则连接不走代理
 * - 不传输任何项目数据：只是对已配置的 API 端点做连接预热
 */

import { profileCheckpoint } from "@sid-code/shared/utils/startup-profiler.ts";

/** 记录已预连接的 origin，避免重复预热 */
const preconnected = new Set<string>();

/**
 * 对给定 base URL 发起预连接。
 *
 * ⚠️ 取不到地址就**跳过**，永不回落 `api.anthropic.com`（P1-11）。原实现只读环境变量
 * `SID_CODE_LLM_BASE_URL`，未设时固定连 Anthropic —— 而通过 settings.json 配网关的用户
 * （团队模板就是这种）从不设这个变量，于是每次启动都向一个与自己无关的第三方暴露启动事实，
 * 首请求也吃不到预热（连的根本不是同一个主机）。调用方应传已解析 config 的主模型 baseURL。
 *
 * @param baseUrl 主模型实际请求的 API 基址；空 / 缺省 / 非法时不发任何请求
 */
export function preconnectApi(baseUrl?: string): void {
  if (!baseUrl || !baseUrl.trim()) return;
  const base = baseUrl;

  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    return; // 非法 URL，静默跳过
  }

  if (preconnected.has(origin)) return;
  preconnected.add(origin);

  profileCheckpoint("api_preconnect_start");

  try {
    // fire-and-forget：建立连接即可，不关心响应。
    // AbortController 兜底，避免预连接请求悬挂占用资源。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    void fetch(origin, { method: "HEAD", signal: controller.signal })
      .then(() => {
        clearTimeout(timer);
      })
      .catch(() => {
        clearTimeout(timer);
        // 预连接失败静默忽略——真实请求会自行重连
      });
  } catch {
    // fetch 同步抛错（极少见）也静默忽略
  }
}

/** 重置预连接记录（仅测试用） */
export function resetPreconnectState(): void {
  preconnected.clear();
}
