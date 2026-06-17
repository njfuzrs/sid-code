/**
 * 加载指示器 Hook
 *
 * 管理加载短语循环 + 计时器，参考 gemini-cli useLoadingIndicator.ts。
 * 计时器在「已提交、未结束」的整个活动窗口（Connecting + Responding）连续运行，
 * 含首字延迟期间——这样回车后立刻有计时在动，且首字到达时不归零，
 * 用户看到的是真实累计等待（根治盲区 1+2）。
 */

import { useState, useEffect, useRef } from "react";
import { StreamingState } from "../types.ts";
import { pickSpinnerVerb } from "../spinnerVerbs.ts";
import { CONNECTING_PHRASE, CONTINUATION_PHRASE, pickSlowHint } from "../constants/loading-phrases.ts";

/** 短语切换间隔（毫秒） */
const PHRASE_INTERVAL = 4000;

export interface UseLoadingIndicatorProps {
  streamingState: StreamingState;
  toolName?: string | null;
  /**
   * 本轮已产出的 output token 数（文本 + 思考累计）。仅作「模型是否在产出」的探针：
   * 它一旦变化（或文本流式推进），就说明模型在动 → 重置静默计时。
   * 慢提示据此只在「真正一段时间收不到任何输出」时出现，而非整轮耗时长就报。
   */
  outputTokens?: number;
}

export interface UseLoadingIndicatorReturn {
  /** 已过秒数（整轮，从进入活动态起连续计时） */
  elapsedTime: number;
  /** 当前加载短语 */
  currentLoadingPhrase: string | null;
  /** 慢响应渐进提示（达「静默」阈值才出现，否则 null） */
  slowHint: string | null;
  /** L3：当前工具已执行秒数（toolName 变化即重置）。无工具执行时为 0。 */
  toolElapsedTime: number;
}

export function useLoadingIndicator({
  streamingState,
  toolName,
  outputTokens = 0,
}: UseLoadingIndicatorProps): UseLoadingIndicatorReturn {
  const [elapsedTime, setElapsedTime] = useState(0);
  const [toolElapsedTime, setToolElapsedTime] = useState(0);
  // 静默时长：距上次「检测到模型产出」的秒数。token 在流就归零，
  // 只有真正卡住（一段时间零产出）才会累积上去 → 作为慢提示的准确信号。
  const [silenceSec, setSilenceSec] = useState(0);
  const [currentPhrase, setCurrentPhrase] = useState<string>(() =>
    pickSpinnerVerb(),
  );
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const toolTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const phraseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevStateRef = useRef<StreamingState>(StreamingState.Idle);
  const prevToolRef = useRef<string | null>(null);
  const prevTokensRef = useRef<number>(0);

  const isConnecting = streamingState === StreamingState.Connecting;
  const isResponding = streamingState === StreamingState.Responding;
  // 计时器在「已提交、未结束」的整个活动窗口都跑（含首字延迟）。
  const isActive = isConnecting || isResponding;

  // 计时器：每秒递增。活动窗口（Connecting 或 Responding）期间持续运行。
  // 整轮 elapsedTime 与静默 silenceSec 同一 tick 推进：elapsedTime 只增，
  // silenceSec 在「检测到产出」时由下方 effect 归零，故二者分工明确——
  // 前者给用户看「等了多久」，后者只用于判断「是否真的卡住」。
  useEffect(() => {
    if (isActive) {
      timerRef.current = setInterval(() => {
        setElapsedTime(t => t + 1);
        setSilenceSec(t => t + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isActive]);

  // 静默归零：只要检测到模型在产出（output token 增长），就把静默计时清零。
  // 这是慢提示的核心——token 在流就绝不报「慢/卡住」，避免把「整轮耗时长」
  // 误当成「卡住」（agentic 多步循环里一轮超 10s 再正常不过，不该报警）。
  useEffect(() => {
    if (outputTokens > prevTokensRef.current) {
      setSilenceSec(0);
    }
    prevTokensRef.current = outputTokens;
  }, [outputTokens]);

  // 计时器归零：仅在「从非活动态进入活动态」的上升沿归零一次，
  // Connecting → Responding 的内部切换不归零（保持连续计时，根治盲区 2）。
  useEffect(() => {
    const prev = prevStateRef.current;
    const wasActive =
      prev === StreamingState.Connecting || prev === StreamingState.Responding;
    const nowActive =
      streamingState === StreamingState.Connecting ||
      streamingState === StreamingState.Responding;
    if (!wasActive && nowActive) {
      // 上升沿：回车进入 Connecting（或极快直达 Responding）。
      setElapsedTime(0);
      setSilenceSec(0);
      setCurrentPhrase(pickSpinnerVerb());
    }
    prevStateRef.current = streamingState;
  }, [streamingState]);

  // 短语循环：仅 Responding 且无工具时循环动词；
  // Connecting 用固定的「连接中…」文案，不与 Responding 动词池混用。
  useEffect(() => {
    if (isResponding && !toolName) {
      phraseTimerRef.current = setInterval(() => {
        setCurrentPhrase(prev => pickSpinnerVerb(prev));
      }, PHRASE_INTERVAL);
    } else {
      if (phraseTimerRef.current) {
        clearInterval(phraseTimerRef.current);
        phraseTimerRef.current = null;
      }
    }
    return () => {
      if (phraseTimerRef.current) {
        clearInterval(phraseTimerRef.current);
        phraseTimerRef.current = null;
      }
    };
  }, [isResponding, toolName]);

  // L3 方向 1：工具级计时。toolName 非空时每秒递增，toolName 变化（换工具）或
  // 清空（工具结束）即重置归零。与整轮 elapsedTime 区分——长 turn 里整轮计时可能
  // 已很大，但单个工具刚开始，工具级计时让用户看到「这个工具自己跑了多久」。
  useEffect(() => {
    const hasTool = !!toolName;
    // 换工具 / 进入工具执行 → 归零重计。
    if (toolName !== prevToolRef.current) {
      setToolElapsedTime(0);
      prevToolRef.current = toolName ?? null;
    }
    if (hasTool) {
      toolTimerRef.current = setInterval(() => {
        setToolElapsedTime(t => t + 1);
      }, 1000);
    } else {
      if (toolTimerRef.current) {
        clearInterval(toolTimerRef.current);
        toolTimerRef.current = null;
      }
    }
    return () => {
      if (toolTimerRef.current) {
        clearInterval(toolTimerRef.current);
        toolTimerRef.current = null;
      }
    };
  }, [toolName]);

  // 当前文案：Connecting → 「连接中…」（首字未到）或「处理中…」（步间空档，
  // 本轮已产出过 token，是 agentic 循环的步与步之间，不是真在连接）；
  // Responding 无工具 → 动词；有工具 → null（由组件拼 "执行 X…"）。
  const currentLoadingPhrase = isConnecting
    ? prevTokensRef.current > 0
      ? CONTINUATION_PHRASE
      : CONNECTING_PHRASE
    : isResponding && !toolName
      ? currentPhrase
      : null;

  // 慢提示：仅在「连接中」或「流式无工具」时给（工具执行有自己的耗时显示，不重复打扰）。
  // 关键——用「静默时长」silenceSec 而非整轮 elapsedTime：模型在持续产出（含思考）时
  // silenceSec 一直归零，绝不报慢；只有真正一段时间收不到任何输出（疑似卡住）才提示。
  const slowHint =
    isConnecting || (isResponding && !toolName)
      ? pickSlowHint(silenceSec)
      : null;

  return {
    elapsedTime,
    currentLoadingPhrase,
    slowHint,
    toolElapsedTime,
  };
}
