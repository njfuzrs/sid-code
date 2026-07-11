/**
 * think 工具（G19 首个新泛型 Tool 采用者）
 *
 * 对标 claude-code 的 Think 工具：给模型一个"结构化思考暂存区"——把推理/计划/权衡
 * 显式写下来，不产生任何副作用（不读文件、不改状态、不发网络）。用途是让模型在复杂
 * 多步任务里"想清楚再动手"，思考内容记入对话历史供后续步骤参考。
 *
 * 这是全仓**第一个用新泛型 `buildTool()` 定义、经 `toLegacyTool()` bridge 注册到产线
 * registry 的工具**（G19：此前 buildTool/bridge 只有定义、零采用）。它同时行使了新接口
 * 的核心能力字段——zodSchema（运行时校验 + JSON Schema 生成）、isReadOnly / isConcurrencySafe
 * （纯思考无副作用，读写并发都安全）、toAutoClassifierInput（对安全分类器自报"与安全无关"）——
 * 验证 bridge 的能力透传链路真实可用。
 */

import { z } from "zod/v4";
import { buildTool, type Tool } from "./types.ts";
import { toLegacyTool } from "./bridge.ts";
import type { LegacyTool } from "./types.ts";

/** think 输入 schema —— 运行时校验 + JSON Schema 生成的唯一真相源 */
const thinkSchema = z.object({
  thought: z.string().describe("要记录的思考内容（推理过程、计划、权衡、下一步打算等）"),
});

type ThinkInput = z.infer<typeof thinkSchema>;

/** 新泛型 Tool 实例（G19 示范用法） */
export const thinkTool: Tool<ThinkInput, string> = buildTool<ThinkInput, string>({
  name: "think",

  description() {
    return (
      "记录一段结构化思考。用于在复杂多步任务中把推理、计划或权衡显式写下来，" +
      "帮助理清思路后再行动。此工具无任何副作用（不读写文件、不改变状态），仅把思考记入对话历史。"
    );
  },

  usageGuide() {
    return `- 面对复杂/多步/易错的任务时，先用 think 梳理计划与权衡，再动手
- 遇到分支决策（多种方案取舍）时，用 think 列出选项与理由
- 不要用它执行动作或读写数据——它只是思考暂存区
- 简单直接的任务无需使用`;
  },

  inputSchema() {
    return z.toJSONSchema(thinkSchema) as Record<string, unknown>;
  },

  // 纯思考：读写并发都安全，只读、非破坏
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },

  // 能力字段：交执行器做运行时校验 + registry 生成 LLM 定义
  zodSchema: thinkSchema,

  // 对 auto 模式安全分类器自报"与安全无关"，跳过 LLM 判断（降噪）
  toAutoClassifierInput() {
    return "";
  },

  async call(input) {
    const thought = (input?.thought ?? "").trim();
    if (!thought) {
      return { data: "（未提供思考内容）", isError: true };
    }
    // 思考已通过 tool_use 记入对话历史，这里只回一个确认。
    return { data: "已记录思考。" };
  },
});

/**
 * 经 bridge 适配为 LegacyTool，可直接 registry.register()。
 * 这是 G19 的落地点：新泛型 Tool → toLegacyTool → 产线 registry。
 */
export function createThinkTool(): LegacyTool {
  return toLegacyTool(thinkTool);
}
