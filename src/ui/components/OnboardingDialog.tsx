/**
 * 首次启动引导对话框（OnboardingDialog）
 *
 * 用户第一次使用 sid-code 时未配置 API Key / provider / model，TUI 自动弹出此对话框
 * 分步收集配置。完成后写入 ~/.sid-code/settings.json 并热加载 Provider。
 *
 * 分步流程：
 *   1. Provider 选择（anthropic / openai / ollama / 其他 OpenAI 兼容）
 *   2. Base URL（可选，留空走默认；ollama 预填 localhost）
 *   3. Model 名称（文本输入，给提示）
 *   4. API Key（文本输入，掩码渲染；ollama 跳过）
 *
 * 遵循 src/ui/CLAUDE.md：
 *   - 单 round 容器 + 品牌蓝标题（L2.2）
 *   - 字形取 figures.ts（L1.1）
 *   - ESC 可关闭不退出程序（L4-B 中断给出路）
 *   - 键盘可达（L4-F）
 */

import React, { useState, useRef } from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { useKeypress, KeypressPriority } from "../contexts/KeypressContext.tsx";
import { theme } from "../semantic-colors.ts";
import { BULLET, ARROW_PROMPT, SUCCESS_MARK, CURSOR } from "../constants/figures.ts";

/** 收集的配置结果 */
export interface OnboardingResult {
  provider: string;
  baseURL: string;
  model: string;
  apiKey: string;
}

interface OnboardingDialogProps {
  onComplete: (result: OnboardingResult) => void;
  onClose: () => void;
}

/** Provider 预设选项 */
const PROVIDER_OPTIONS = [
  { key: "openai", label: "OpenAI 兼容", description: "支持 OpenAI 协议的服务（包括 DeepSeek、通义千问等）" },
  { key: "anthropic", label: "Anthropic", description: "Claude 系列模型" },
  { key: "ollama", label: "Ollama（本地）", description: "本地部署，无需 API Key" },
] as const;

/** 根据 provider 给出模型名提示 */
function getModelHint(provider: string): string {
  switch (provider) {
    case "anthropic": return "如 claude-sonnet-4-20250514";
    case "ollama": return "如 llama3、qwen2";
    default: return "如 gpt-4o、deepseek-chat、qwen-plus";
  }
}

/** 根据 provider 给出默认 baseURL 提示 */
function getBaseURLHint(provider: string): string {
  switch (provider) {
    case "anthropic": return "留空使用默认 https://api.anthropic.com";
    case "ollama": return "留空使用默认 http://localhost:11434/v1";
    default: return "留空使用默认 https://api.openai.com/v1，或输入自定义地址";
  }
}

/** 掩码渲染 API Key（仅显示末 4 位） */
function maskKey(key: string): string {
  if (key.length <= 4) return "•".repeat(key.length);
  return "•".repeat(key.length - 4) + key.slice(-4);
}

type Step = "provider" | "baseURL" | "model" | "apiKey" | "confirm";

export function OnboardingDialog({ onComplete, onClose }: OnboardingDialogProps) {
  const [step, setStep] = useState<Step>("provider");
  const [providerCursor, setProviderCursor] = useState(0);
  const [provider, setProvider] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const completedRef = useRef(false);

  const accent = theme.ui.active;

  // 提交最终结果
  const submit = () => {
    if (completedRef.current) return;
    completedRef.current = true;
    onComplete({
      provider,
      baseURL: baseURL.trim(),
      model: model.trim(),
      apiKey: apiKey.trim(),
    });
  };

  // 进入下一步
  const nextStep = () => {
    switch (step) {
      case "provider":
        setProvider(PROVIDER_OPTIONS[providerCursor].key);
        setStep("baseURL");
        // ollama 预填 baseURL
        if (PROVIDER_OPTIONS[providerCursor].key === "ollama") {
          setBaseURL("http://localhost:11434/v1");
        }
        break;
      case "baseURL":
        setStep("model");
        break;
      case "model":
        // ollama 跳过 apiKey
        if (provider === "ollama") {
          setStep("confirm");
        } else {
          setStep("apiKey");
        }
        break;
      case "apiKey":
        setStep("confirm");
        break;
      case "confirm":
        submit();
        break;
    }
  };

  useKeypress(KeypressPriority.Critical, (key) => {
    if (completedRef.current) return false;

    // ESC：关闭对话框（不退出程序，回到 EmptyLogo）
    if (key.name === "escape") {
      onClose();
      return true;
    }

    // ── Provider 选择步骤 ──
    if (step === "provider") {
      if (key.name === "up" || (key.ctrl && key.name === "p")) {
        setProviderCursor((c) => (c - 1 + PROVIDER_OPTIONS.length) % PROVIDER_OPTIONS.length);
        return true;
      }
      if (key.name === "down" || (key.ctrl && key.name === "n")) {
        setProviderCursor((c) => (c + 1) % PROVIDER_OPTIONS.length);
        return true;
      }
      if (key.name === "return" || key.name === "enter") {
        nextStep();
        return true;
      }
      return false;
    }

    // ── 文本输入步骤（baseURL / model / apiKey）──
    if (step === "baseURL" || step === "model" || step === "apiKey") {
      const setText = step === "baseURL" ? setBaseURL : step === "model" ? setModel : setApiKey;

      if (key.name === "return" || key.name === "enter") {
        // model 必填
        if (step === "model" && model.trim().length === 0) return true;
        // apiKey 必填（非 ollama）
        if (step === "apiKey" && apiKey.trim().length === 0) return true;
        nextStep();
        return true;
      }
      if (key.name === "backspace" || key.name === "delete") {
        setText((t) => t.slice(0, -1));
        return true;
      }
      if (key.insertable && key.sequence) {
        setText((t) => t + key.sequence);
        return true;
      }
      return true; // 输入态吞掉其它按键
    }

    // ── 确认步骤 ──
    if (step === "confirm") {
      if (key.name === "return" || key.name === "enter") {
        submit();
        return true;
      }
      return false;
    }

    return false;
  });

  // ═══════════ 渲染 ═══════════

  const stepTitles: Record<Step, string> = {
    provider: "选择 Provider",
    baseURL: "设置 Base URL",
    model: "输入模型名称",
    apiKey: "输入 API Key",
    confirm: "确认配置",
  };

  const stepNum = ["provider", "baseURL", "model", "apiKey", "confirm"].indexOf(step) + 1;
  const totalSteps = provider === "ollama" ? 4 : 5;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
      {/* 标题行 */}
      <Box>
        <Text color={accent} bold>{BULLET} 首次配置</Text>
        <Text color={theme.text.secondary}>  ({stepNum}/{totalSteps})</Text>
      </Box>
      <Box paddingLeft={2} marginBottom={1}>
        <Text color={theme.text.secondary}>{stepTitles[step]}</Text>
      </Box>

      {/* Provider 选择 */}
      {step === "provider" && (
        <Box flexDirection="column" paddingLeft={2}>
          {PROVIDER_OPTIONS.map((opt, i) => {
            const isCursor = providerCursor === i;
            return (
              <Box key={opt.key} flexDirection="column">
                <Box>
                  <Box width={2} flexShrink={0}>
                    <Text color={isCursor ? accent : theme.text.secondary}>
                      {isCursor ? BULLET : " "}
                    </Text>
                  </Box>
                  <Text color={isCursor ? accent : theme.text.primary} bold={isCursor}>
                    {opt.label}
                  </Text>
                </Box>
                {isCursor && (
                  <Box paddingLeft={2}>
                    <Text color={theme.text.secondary}>{opt.description}</Text>
                  </Box>
                )}
              </Box>
            );
          })}
          <Box marginTop={1} paddingLeft={2}>
            <Text color={theme.text.secondary}>↑↓ 选择  Enter 确认  Esc 关闭</Text>
          </Box>
        </Box>
      )}

      {/* Base URL 输入 */}
      {step === "baseURL" && (
        <Box flexDirection="column" paddingLeft={2}>
          <Box marginBottom={1}>
            <Text color={theme.text.secondary}>{getBaseURLHint(provider)}</Text>
          </Box>
          <Box>
            <Text color={accent}>{ARROW_PROMPT} </Text>
            <Text>{baseURL}</Text>
            <Text color={accent}>{CURSOR}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>Enter 确认（可留空）  Esc 关闭</Text>
          </Box>
        </Box>
      )}

      {/* Model 名称输入 */}
      {step === "model" && (
        <Box flexDirection="column" paddingLeft={2}>
          <Box marginBottom={1}>
            <Text color={theme.text.secondary}>{getModelHint(provider)}</Text>
          </Box>
          <Box>
            <Text color={accent}>{ARROW_PROMPT} </Text>
            <Text>{model}</Text>
            <Text color={accent}>{CURSOR}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>Enter 确认  Esc 关闭</Text>
          </Box>
        </Box>
      )}

      {/* API Key 输入（掩码） */}
      {step === "apiKey" && (
        <Box flexDirection="column" paddingLeft={2}>
          <Box marginBottom={1}>
            <Text color={theme.text.secondary}>
              输入你的 API Key（将保存到 ~/.sid-code/settings.json）
            </Text>
          </Box>
          <Box>
            <Text color={accent}>{ARROW_PROMPT} </Text>
            <Text>{maskKey(apiKey)}</Text>
            <Text color={accent}>{CURSOR}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>Enter 确认  Esc 关闭</Text>
          </Box>
        </Box>
      )}

      {/* 确认步骤 */}
      {step === "confirm" && (
        <Box flexDirection="column" paddingLeft={2}>
          <Box><Text color={theme.text.secondary}>Provider: </Text><Text>{provider}</Text></Box>
          {baseURL ? (
            <Box><Text color={theme.text.secondary}>Base URL: </Text><Text>{baseURL}</Text></Box>
          ) : null}
          <Box><Text color={theme.text.secondary}>Model:    </Text><Text>{model}</Text></Box>
          {apiKey ? (
            <Box><Text color={theme.text.secondary}>API Key:  </Text><Text>{maskKey(apiKey)}</Text></Box>
          ) : null}
          <Box marginTop={1}>
            <Text color={accent}>{SUCCESS_MARK} 按 Enter 保存配置并开始使用</Text>
          </Box>
          <Box>
            <Text color={theme.text.secondary}>Esc 取消</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
