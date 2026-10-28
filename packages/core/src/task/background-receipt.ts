/**
 * Q1：三处后台回执（子代理 / bash 后台 / Ctrl+B）共用的禁令文案。
 *
 * 单独成叶子模块（零依赖）：`tool/bash.ts` 对 task 模块一贯走惰性 require，静态 import
 * `background-poll-guard.ts` 会把 registry 一并拉进来。文案常量不需要那条依赖。
 *
 * 不再给「read output_file」的许可：P2 测到一句 20 字的许可就能抵消 system 与工具描述里的
 * 多处禁令（离行动最近的那条赢）。
 */
export const BACKGROUND_RECEIPT_NOTICE =
  "完成后会以 <task-notification> 自动通知你。运行期间不要 read / ls / tail / cat 它的 output_file 或 tasks 目录，" +
  "也不要用 task_output / bg_task_get 阻塞等待或轮询（运行中这类调用会被拦截）；继续做不依赖它的工作，" +
  "或简短告诉用户启动了什么并结束本轮。用户问进度时，如实说任务仍在运行、完成后会自动送达。";
