/**
 * 渲染底座的唯一选择点（B9 / T1.3）。
 *
 * 同一进程只能用一套底座：Box/Text 的宿主类型与 render 的 reconciler 必须同源（设计文档 D-4），
 * 所以在模块加载时判定一次，七个端口模块都读这里的 `RENDERER`，不各自读环境变量。
 * 各自读的话，两个模块读到不同的值（测试里中途改 env 就会这样）会混用两套底座，
 * 表现是 React 报宿主类型未知或 hooks 拿不到 Context，很难归因到开关上。
 */

export type RendererImpl = "legacy" | "next";

/**
 * T8.2 起默认 next。legacy 保留到 T9 删除旧底座之前，作为 `SID_TUI_RENDERER=legacy` 回退口：
 * 新底座出问题时用户改一个环境变量就能回到旧行为，不必降版本。
 */
export const DEFAULT_RENDERER: RendererImpl = "next";

/**
 * 解析 `SID_TUI_RENDERER`。未设置 / 空串 → 默认值；无法识别的值也回落默认值，同时在 stderr 留一行。
 * 不抛错：这是灰度开关，环境里残留一个拼错的值不应该让用户启动不了。
 */
export function resolveRenderer(
  raw: string | undefined,
  warn: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): RendererImpl {
  const v = raw?.trim().toLowerCase();
  if (!v) return DEFAULT_RENDERER;
  if (v === "legacy" || v === "next") return v;
  warn(
    `[sid-code] SID_TUI_RENDERER=${JSON.stringify(raw)} 无法识别（可选 legacy | next），使用 ${DEFAULT_RENDERER}`,
  );
  return DEFAULT_RENDERER;
}

export const RENDERER: RendererImpl = resolveRenderer(process.env.SID_TUI_RENDERER);
