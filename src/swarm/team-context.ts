/**
 * 团队成员身份上下文（AsyncLocalStorage）
 *
 * 问题：`team_message` 工具要能让**成员**给 leader / 其他 peer 发消息，就必须知道
 * "当前是谁在调用"。工具签名里没有调用方身份（所有子代理共用同一 Registry 实例），
 * 而 N 个成员并发跑，用模块级全局变量记"当前成员"必然串台。
 *
 * 方案：与 bootstrap/cwd-context.ts 同款——用 AsyncLocalStorage 给成员的整条异步执行链
 * 绑定 `{ teamName, memberName, mailbox }`。成员内部任何深度的工具调用都能读到自己的
 * 身份与团队邮箱句柄，并发安全（跨 await 不串台）。
 *
 * 未进入 withTeamMember 时 store 为空 → team_message 工具报"不在团队上下文中"，
 * 主代理直接调用该工具时行为明确（而非误发到某个残留成员身上）。
 *
 * ⚠️ 低依赖：只 import 类型，不引业务模块，避免循环依赖。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Mailbox } from "./mailbox.ts";

export interface TeamMemberContext {
  /** 团队名 */
  teamName: string;
  /** 当前成员名（发信人身份） */
  memberName: string;
  /** 团队邮箱句柄（成员据此投递消息） */
  mailbox: Mailbox;
  /** 团队全部成员名（用于校验收信人是否存在） */
  memberNames: string[];
}

const teamStorage = new AsyncLocalStorage<TeamMemberContext>();

/** 在绑定到某成员身份的异步上下文里运行 fn。期间 getTeamMemberContext() 返回该身份。 */
export function withTeamMember<T>(ctx: TeamMemberContext, fn: () => T): T {
  return teamStorage.run(ctx, fn);
}

/** 取当前异步上下文绑定的团队成员身份；不在任何 withTeamMember 内时返回 undefined。 */
export function getTeamMemberContext(): TeamMemberContext | undefined {
  return teamStorage.getStore();
}
