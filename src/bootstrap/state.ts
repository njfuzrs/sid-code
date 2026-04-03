/**
 * 全局状态容器
 * ⚠️ 低依赖模块——只 import 类型定义，不 import 业务模块
 * ⚠️ DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE
 *
 * 设计原则：
 * 1. 零业务依赖——任何模块都可以安全 import 而不引入循环依赖
 * 2. getter/setter 访问——变更可追踪，可附加副作用
 * 3. 克制增长——只放真正需要跨模块共享的最小状态集
 */

interface BootstrapState {
  // 项目身份（启动时设置，不变）
  originalCwd: string;
  projectRoot: string;

  // 运行时状态
  cwd: string;
  isInteractive: boolean;
  sessionId: string;

  // 成本追踪
  totalCostUSD: number;
  totalAPIDuration: number;
  totalToolDuration: number;
  modelUsage: Record<string, { inputTokens: number; outputTokens: number }>;

  // 模型配置
  mainLoopModelOverride: string | undefined;
  initialMainLoopModel: string;
}

const state: BootstrapState = {
  originalCwd: process.cwd(),
  projectRoot: process.cwd(),
  cwd: process.cwd(),
  isInteractive: process.stdout.isTTY ?? false,
  sessionId: "",
  totalCostUSD: 0,
  totalAPIDuration: 0,
  totalToolDuration: 0,
  modelUsage: {},
  mainLoopModelOverride: undefined,
  initialMainLoopModel: "",
};

// --- 工作目录 ---

export function getCwd(): string {
  return state.cwd;
}
export function setCwd(newCwd: string): void {
  state.cwd = newCwd;
}

export function getOriginalCwd(): string {
  return state.originalCwd;
}

export function getProjectRoot(): string {
  return state.projectRoot;
}
export function setProjectRoot(root: string): void {
  state.projectRoot = root;
}

// --- 会话 ---

export function getSessionId(): string {
  return state.sessionId;
}
export function setSessionId(id: string): void {
  state.sessionId = id;
}

// --- 交互模式 ---

export function isInteractive(): boolean {
  return state.isInteractive;
}
export function setInteractive(v: boolean): void {
  state.isInteractive = v;
}

// --- 成本追踪 ---

export function addCost(usd: number): void {
  state.totalCostUSD += usd;
}
export function getTotalCost(): number {
  return state.totalCostUSD;
}

export function addAPIDuration(ms: number): void {
  state.totalAPIDuration += ms;
}
export function getTotalAPIDuration(): number {
  return state.totalAPIDuration;
}

export function addToolDuration(ms: number): void {
  state.totalToolDuration += ms;
}
export function getTotalToolDuration(): number {
  return state.totalToolDuration;
}

// --- 模型用量 ---

export function addModelUsage(
  model: string,
  input: number,
  output: number,
): void {
  const existing = state.modelUsage[model] ?? {
    inputTokens: 0,
    outputTokens: 0,
  };
  existing.inputTokens += input;
  existing.outputTokens += output;
  state.modelUsage[model] = existing;
}

export function getModelUsage(): Record<
  string,
  { inputTokens: number; outputTokens: number }
> {
  return { ...state.modelUsage };
}

// --- 模型配置 ---

export function getMainLoopModelOverride(): string | undefined {
  return state.mainLoopModelOverride;
}
export function setMainLoopModelOverride(model: string | undefined): void {
  state.mainLoopModelOverride = model;
}

export function getInitialMainLoopModel(): string {
  return state.initialMainLoopModel;
}
export function setInitialMainLoopModel(model: string): void {
  state.initialMainLoopModel = model;
}
