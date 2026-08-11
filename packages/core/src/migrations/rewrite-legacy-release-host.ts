/**
 * 迁移 v3：把存量 settings.json 里的旧 IP 服务地址改写成域名 + https
 *
 * 背景（2026-08-06 域名切换的善后）：官网/发布服务器从 `http://121.196.144.227` 切到
 * `https://www.sid-code.cc` 并签了证书。服务器随后对 80 端口做了**全局** 301 → https，
 * 而证书只签了域名（Let's Encrypt 不签 IP 证书），于是所有指向 IP 的 http 请求变成
 * 「301 → https://<ip>/ → TLS 校验失败」。
 *
 * 受影响的**不只是**下载链路（那个靠发新版解决），还有**用户 settings.json 里的两个
 * 运行时服务地址**——它们是 install.sh 首装时整份拷贝团队默认配置写进去的：
 *   · search.searxngUrl   → 联网搜索
 *   · trace.upload.url    → 轨迹上传
 * 这两处一旦失效，功能是**静默不可用**（搜索无结果 / 轨迹默默传不上去），
 * 用户不会收到任何指向根因的报错。
 *
 * ## 为什么必须是迁移，而不是「改模板 + 发新版」
 *
 * 改 `scripts/team-defaults.template.json` 只影响**新装用户**：install.sh 的语义是
 * 「settings.json 不存在才整份拷贝」，已有配置的机器永远不会被它碰到。
 * 迁移 v1（backfill-team-defaults）也救不了——它只补**用户缺失的顶层键**，
 * 而这些用户的 `search` / `trace` 键是**存在**的，只是值里的 host 过期了。
 * 所以这是一类新问题：**不是缺字段，是字段值失效**，只能靠定向改写。
 *
 * ## 改写策略：只认这一个已知失效的 origin，宁可漏改不可错改
 *
 * 只匹配 `http://121.196.144.227`（可带端口 80）这一个确切前缀，替换为
 * `https://www.sid-code.cc`，**路径部分原样保留**（`/searxng`、`/traj` 路径结构没变）。
 * 刻意**不**做「任何 IP 都改成域名」这类泛化：用户可能自建了内网 searxng 或私有轨迹平台，
 * 把那些地址改成我们的域名等于**把用户的私有数据指向我们的服务器**，比不迁移严重得多。
 *
 * 同理只在**值以该 origin 开头**时才动，不做子串替换——避免误伤把 IP 写在
 * 备注、token、query 参数里的情况。
 *
 * ## 幂等与安全
 *
 * - 靠 runner 版本水位线保证只跑一次；额外靠「没有任何字段匹配就直接 return」兜第二层，
 *   所以不写盘、不打日志的路径是绝对多数（自建地址 / 新装用户 / 已手工改过的用户）。
 * - 写盘走 `patchSettingsFile`：直接读原始 JSON 文本、只改目标顶层键，
 *   不过 Zod round-trip。这点是硬要求——round-trip 会 strip 掉未声明字段
 *   并把 `${API_KEY}` 占位符展开成明文落盘（见 settings.ts 的注释）。
 * - **只动 userSettings**（`~/.sid-code/settings.json`）。项目级 settings 可能已提交 git，
 *   静默改写会污染用户的工作区 diff；那种情况留给用户自己处理，见收尾提示。
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { patchSettingsFile } from "../config/settings/settings.ts";
import { getSidHome } from "../config/paths.ts";

/**
 * 已失效的旧 origin。带端口的写法一并认（`:80` 与省略等价）。
 * 只有这一个——见文件头「宁可漏改不可错改」。
 */
const LEGACY_ORIGINS = ["http://121.196.144.227:80", "http://121.196.144.227"] as const;

const NEW_ORIGIN = "https://www.sid-code.cc";

/**
 * 值以某个失效 origin 开头时换掉 origin、保留路径；否则返回 null 表示「不该动」。
 * 返回 null 而不是原值，是为了让调用方能区分「改了」和「没改」，
 * 从而决定是否写盘（没改就不该碰文件）。
 */
function rewriteOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  for (const legacy of LEGACY_ORIGINS) {
    if (value === legacy) return NEW_ORIGIN;
    if (value.startsWith(`${legacy}/`)) {
      return NEW_ORIGIN + value.slice(legacy.length);
    }
  }
  return null;
}

/** 浅拷贝一层对象，避免就地改到缓存里的同一个引用 */
function shallowClone(obj: Record<string, unknown>): Record<string, unknown> {
  return { ...obj };
}

/**
 * 读用户全局 settings.json 的**原始 JSON 文本**。
 *
 * 刻意不用 `getSettingsForSource()`：那条路会过 Zod safeParse（strip 掉未声明字段）
 * 并展开 `${ENV}` 占位符，拿到的是**加工后**的对象。用它做判断有两个坏处：
 *   1. 若 schema 没声明某字段，读出来就是 undefined，会误判成「没配」而漏改；
 *   2. 占位符已被展开，一旦据此写回就等于把明文密钥落盘。
 * 这里要的是「文件里到底写了什么」，所以直接读文本。
 * 解析失败一律返回 null（当作无事可做）——迁移语义是失败不阻塞启动，
 * 更不能因为文件损坏就去覆盖它。
 */
function readRawUserSettings(): Record<string, unknown> | null {
  try {
    const path = join(getSidHome(), "settings.json");
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function migrate(): void {
  const current = readRawUserSettings();
  if (!current) return;

  const changed: string[] = [];

  // ── search.searxngUrl ──
  const search = current.search;
  if (search && typeof search === "object" && !Array.isArray(search)) {
    const s = search as Record<string, unknown>;
    const next = rewriteOrigin(s.searxngUrl);
    if (next !== null) {
      const patched = shallowClone(s);
      patched.searxngUrl = next;
      patchSettingsFile("userSettings", "search", patched);
      changed.push("search.searxngUrl（联网搜索）");
    }
  }

  // ── trace.upload.url ──
  // 嵌套两层：patchSettingsFile 的粒度是顶层键，所以整块 trace 改完再写回。
  // 必须逐层浅拷贝，否则会改到缓存里那个对象。
  const trace = current.trace;
  if (trace && typeof trace === "object" && !Array.isArray(trace)) {
    const t = trace as Record<string, unknown>;
    const upload = t.upload;
    if (upload && typeof upload === "object" && !Array.isArray(upload)) {
      const u = upload as Record<string, unknown>;
      const next = rewriteOrigin(u.url);
      if (next !== null) {
        const patchedUpload = shallowClone(u);
        patchedUpload.url = next;
        const patchedTrace = shallowClone(t);
        patchedTrace.upload = patchedUpload;
        patchSettingsFile("userSettings", "trace", patchedTrace);
        changed.push("trace.upload.url（轨迹上传）");
      }
    }
  }

  if (changed.length === 0) return;

  // 必须告知用户：这两个功能此前是**静默失效**的，现在恢复了。
  // 不说的话，用户既不知道它坏过，也无法把「搜索突然又能用了」和本次升级关联起来。
  console.log(
    `已把失效的服务地址更新为域名（${NEW_ORIGIN}）: ${changed.join("、")}\n` +
      `  原因：发布服务器已启用 HTTPS，旧的 IP 地址会因证书不匹配而连接失败，\n` +
      `  这两项功能在此之前是静默不可用的（不报错，只是没有结果）。\n` +
      `  若你的项目级 .sid-code/settings.json 里也写了旧 IP，需自行更新（本次只改用户全局配置）。`,
  );
}
