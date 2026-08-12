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
import {
  CONNECTING_PHRASE,
  CONTINUATION_PHRASE,
  pickSlowHint,
} from "../constants/loading-phrases.ts";

/** 短语切换间隔（毫秒） */
const PHRASE_INTERVAL = 4000;

export interface UseLoadingIndicatorProps {
  streamingState: StreamingState;
  toolName?: string | null;
  /**
   * 产出进度探针：本轮已流式产出的字符数（streamingText + streamingThinking 长度）。
   *
   * ⚠️ 必须用「实时」信号——streamingText/streamingThinking 每来一段 token 就更新，
   * 单次长输出期间也持续增长。不要用 outputTokens：它只在每次 LLM response 完整
   * 结束后才更新一次（loop.ts 的 updateUsage），单次流式过程中纹丝不动，
   * 拿它当探针会导致「模型正在连续输出长回答」时静默计时仍累积 → 误报慢。
   *
   * 此值一旦增长就说明模型在产出 → 重置静默计时。慢提示据此只在「真正一段时间
   * 收不到任何输出」（疑似卡顿）时出现。
   */
  progressCount?: number;
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
  progressCount = 0,
}: UseLoadingIndicatorProps): UseLoadingIndicatorReturn {
  const [elapsedTime, setElapsedTime] = useState(0);
  const [toolElapsedTime, setToolElapsedTime] = useState(0);
  // 静默时长：距上次「检测到模型产出」的秒数。token 在流就归零，
  // 只有真正卡住（一段时间零产出）才会累积上去 → 作为慢提示的准确信号。
  const [silenceSec, setSilenceSec] = useState(0);
  const [currentPhrase, setCurrentPhrase] = useState<string>(() => pickSpinnerVerb());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const toolTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const phraseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevStateRef = useRef<StreamingState>(StreamingState.Idle);
  const prevToolRef = useRef<string | null>(null);
  const prevProgressRef = useRef<number>(0);
  // 当前是否在执行工具，供计时器闭包实时读取（避免把 toolName 加进 interval 依赖
  // 而频繁重建计时器、漂移 elapsedTime）。工具执行 = 模型在「干活」而非「卡住」，
  // 静默计时此期间应冻结，否则长工具结束后进入下一步会瞬间误报慢。
  const toolActiveRef = useRef<boolean>(false);
  toolActiveRef.current = !!toolName;

  const isConnecting = streamingState === StreamingState.Connecting;
  const isResponding = streamingState === StreamingState.Responding;
  // 计时器在「已提交、未结束」的整个活动窗口都跑（含首字延迟）。
  const isActive = isConnecting || isResponding;

  // 计时器：每秒递增。活动窗口（Connecting 或 Responding）期间持续运行。
  // 整轮 elapsedTime 与静默 silenceSec 同一 tick 推进：elapsedTime 只增（给用户看
  // 「等了多久」），silenceSec 在「检测到产出」时由下方 effect 归零、且工具执行期间
  // 冻结（工具在干活不是模型卡住），只用于判断「是否真的卡住」。
  useEffect(() => {
    if (isActive) {
      timerRef.current = setInterval(() => {
        setElapsedTime((t) => t + 1);
        // 工具执行期间冻结静默计时——避免长工具（git clone / 测试 / sub-agent）的
        // 执行耗时被算成「静默」，导致工具结束进入下一步时瞬间误报慢。
        if (!toolActiveRef.current) {
          setSilenceSec((t) => t + 1);
        }
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

  // 静默归零：检测到模型在产出（流式字符数变化）就把静默计时清零。
  // 这是慢提示的核心——内容在流就绝不报「慢」，避免把「耗时长」误当成「卡住」。
  // 用实时的 progressCount（streamingText+thinking 长度）而非 outputTokens，
  // 后者单次流式期间不更新，长输出时会假性累积静默 → 误报（见 props 注释）。
  //
  // 注意「!==」而非「>」：progressCount 不仅会增长，还会在阶段切换时【回落】——
  // tool_start 清空 streamingText/streamingThinking 使其从 N 落回 0（app.ts:2095），
  // 这标志一个新阶段开始（工具执行 / 下一步等待），静默必须重新从 0 计；
  // 否则上一段已产出的字符数会让回落后的「0 > N 不成立」漏掉归零，
  // 把工具执行耗时累进静默 → 工具一结束进入下一步 Connecting 时瞬间误报慢。
  useEffect(() => {
    if (progressCount !== prevProgressRef.current) {
      setSilenceSec(0);
    }
    prevProgressRef.current = progressCount;
  }, [progressCount]);

  // 计时器归零：仅在「从非活动态进入活动态」的上升沿归零一次，
  // Connecting → Responding 的内部切换不归零（保持连续计时，根治盲区 2）。
  useEffect(() => {
    const prev = prevStateRef.current;
    const wasActive = prev === StreamingState.Connecting || prev === StreamingState.Responding;
    const nowActive =
      streamingState === StreamingState.Connecting || streamingState === StreamingState.Responding;
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
        setCurrentPhrase((prev) => pickSpinnerVerb(prev));
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
    // 换工具 / 进入工具执行 / 工具结束 → 归零重计。
    if (toolName !== prevToolRef.current) {
      setToolElapsedTime(0);
      // 工具状态任何切换都是「进入新阶段」，静默计时同步归零：
      // - 进入工具执行：静默不该在工具干活期间累积（计时器里也已冻结，这里兜底起点）；
      // - 工具结束进入下一步等待：上一步/工具的耗时不该算进新一轮首字等待，
      //   否则长工具结束瞬间 silenceSec 仍是大值 → 误报慢。
      setSilenceSec(0);
      // P2-2：换工具/工具结束也重选 spinner 动词。否则工具结束回到无工具等待期时
      // 会沿用上一个动词（仅计时归零、动词没换），观感不连贯。
      setCurrentPhrase((prev) => pickSpinnerVerb(prev));
      prevToolRef.current = toolName ?? null;
    }
    if (hasTool) {
      toolTimerRef.current = setInterval(() => {
        setToolElapsedTime((t) => t + 1);
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
  // 本轮已产出过内容，是 agentic 循环的步与步之间，不是真在连接）；
  // Responding 无工具 → 动词；有工具 → null（由组件拼 "执行 X…"）。
  const currentLoadingPhrase = isConnecting
    ? prevProgressRef.current > 0
      ? CONTINUATION_PHRASE
      : CONNECTING_PHRASE
    : isResponding && !toolName
      ? currentPhrase
      : null;

  // 慢提示：仅在「连接中」或「流式无工具」时给（工具执行有自己的耗时显示，不重复打扰）。
  // 关键——用「静默时长」silenceSec 而非整轮 elapsedTime：模型在持续产出（含思考）时
  // silenceSec 一直归零，绝不报慢；只有真正一段时间收不到任何输出（疑似卡住）才提示。
  const slowHint = isConnecting || (isResponding && !toolName) ? pickSlowHint(silenceSec) : null;

  return {
    elapsedTime,
    currentLoadingPhrase,
    slowHint,
    toolElapsedTime,
  };
}
