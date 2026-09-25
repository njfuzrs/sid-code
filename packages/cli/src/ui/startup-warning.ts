/**
 * 启动诊断 → 横幅文案。
 *
 * 单行的 schema 警告文案只是「未设置」这类结论，没有 path 就不知道是哪个字段，
 * 所以拼成 `${path}: ${message}`。
 * 多行文案自己把事项说清楚（baseURL 覆盖提示把两个地址分行），再加 path 前缀会变成
 * 「baseURL: 环境变量 baseURL 被…」，而且前缀只挂在第一行，续行对不齐。
 */
export function formatStartupWarning(path: string, message: string): string {
  return message.includes("\n") ? message : `${path}: ${message}`;
}
