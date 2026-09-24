/**
 * 判断数字串 `digits` 是否在 `msg` 中以「数字边界」命中（前后不是 0-9）。
 *
 * 不能用裸 `.includes(digits)`：错误消息常内嵌网关 / CDN 返回的 request id、
 * trace id 等不透明标识符，可能巧合包含目标状态码的数字子串。
 *
 * 实例（2026-07-13 生产事故）：Cloudflare 502 错误消息里的
 * "(request id: 202607130613404387609908268d9d6yjWpBkX0)"，其中
 * "...1340438..." 恰好包含 "404"。用 `.includes("404")` 判定会把这个可重试的
 * 502 服务端错误误判成终端错误 model_not_found，导致重试提前放弃、直接切换到
 * fallback 模型——而此时真实故障只是上游临时过载，多等几秒重试本可成功
 * （消息里其实还有 "overloaded" 这个正确关键词，但排在判断顺序更后面的分支，
 * 被抢先命中的 "404" 短路掉了）。
 *
 * 数字边界匹配保留 "HTTP 404" "code=404" "(404)" 等合法场景，排除被更长数字
 * 串"吞掉"的巧合命中（如 "1340438" 里的 "404"）。
 *
 * 单独成文件的理由：`error-lexicon.ts` 与 `errors.ts` 都要用它，而前者是后者的
 * 依赖。放在 `errors.ts` 里会让词表反向 import 分类器，成环。
 * `error-messages.ts` 曾经自己用裸 `.includes("400"/"429"/"502")` 判状态码，
 * 实测 `"gateway trace 5024 内部错误"` → `server_error`、`"耗时 4001ms 后失败"`
 * → `invalid_request`。两处判据必须共用这一个实现，各写一份就会只修一边。
 */
export function hasBoundaryDigits(msg: string, digits: string): boolean {
  return new RegExp(`(?<!\\d)${digits}(?!\\d)`).test(msg);
}
