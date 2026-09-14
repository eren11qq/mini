// mini loop 层类型契约。
// AgentEvent 10 类照抄 pi `packages/agent/src/types.ts:428-443`(实测,非 12)。
// ProviderEvent 6 类照 PRD line 106(mini 减法:provider 层 start/text_delta/thinking_delta/toolcall_delta/done/error)。

// ---- content 块 ----
export interface TextBlock {
  type: "text";
  text: string;
}
export interface ThinkingBlock {
  type: "thinking";
  text: string;
}
export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}
export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

// ---- messages ----
export type StopReason = "stop" | "tool_use" | "length" | "error" | "aborted";

export interface UserMessage {
  role: "user";
  content: string;
}
export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  stopReason: StopReason;
  errorMessage?: string;
  // Story 9 / AC-S1-3:provider done.usage 由 loop 透传落此,M3 压缩阈值与成本核对的数据源。
  usage?: Usage;
}
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: TextBlock[];
  isError: boolean;
}
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

// ---- context / options ----
export interface LoopContext {
  systemPrompt?: string;
  messages: AgentMessage[];
  tools?: unknown[];
}
export interface RunLoopOptions {
  // H1:裸 readline 的 question 天然异步 → 允许返回 Promise(loop 侧 await;同步实现照旧兼容)。
  confirm?: (prompt: string) => "yes" | "always" | "no" | Promise<"yes" | "always" | "no">;
  // T2 AC-T2-7/8:rules.json 路径(D4:测试注入临时目录,生产 = <cwd>/rules.json)。
  // 缺省 = 不读写 rules(always 退化为一次性 yes)。
  rulesPath?: string;
  maxTurns?: number;
  clock?: () => number;
  // AC-L3-4:外部 abort。loop 在 for-await 顶 + 工具批前查 .aborted;
  // 命中 → partial.stopReason="aborted" → turn_end + agent_end(reason="aborted")。
  // streamFn 自己是否观测 signal 留 S1 真 adapter(fetch 传 signal);L3 loop 缝内查兜底。
  signal?: AbortSignal;
}

// ---- provider 事件(流进 runLoop)----
// toolcall_delta 载 parsed args prefix(id+name+arguments);raw 累积 + salvage
// 解析归 S1 stream adapter(PRD S6),loop 只取最新 arguments 快照。pi 同理。
// AC-S1-3:done.usage? 为 M3 压缩阈值与成本核对来源;adapter 填,loop 透传。
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export type ProviderEvent =
  | { type: "start" }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "toolcall_delta"; id: string; name: string; arguments: unknown }
  | { type: "done"; stopReason: StopReason; usage?: Usage }
  | { type: "error"; stopReason: "error" | "aborted"; errorMessage?: string };

// ---- S1 stream adapter 缝 ----
// createStream(config) 把 config 绑进 StreamFn(loop 缝不变;types.ts:72 注)。
// Transport 是离线测试零网络关键:喂假 transport 回放 SSE 行;S2 mock fetch 走同缝。
export interface ModelDef {
  id: string;
  contextWindow: number;
}
export interface ProviderConfig {
  dialect: "openai-completions" | "anthropic-messages";
  base_url: string;
  key_env: string;
  models: ModelDef[];
}
export type Transport = (
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
) => AsyncIterable<string>;

// ---- streamFn 缝 ----
// 注:(config, context) 形态的 config 绑定留 S1 真 adapter;L1 假流只用 context。
// signal:Story 16"中断当前 LLM 流"——loop 把 options.signal 传进来,真 adapter 透传给
// transport→fetch(原 L3 注释"留 S1"的欠账);假流可忽略第二参。
export type StreamFn = (context: LoopContext, signal?: AbortSignal) => AsyncIterable<ProviderEvent>;

// ---- tool 注册表缝(L2)----
// Tool.run 失败靠返回 isError:true ToolResult 回喂,不 throw(L3 error 进流同样约束)。
// confirm gate 留 T2(beforeToolCall hook),L2 工具直接执行。
export interface Tool {
  name: string;
  // H1 装配发现:方言适配器把 context.tools 翻成 provider 的 function 数组时要用
  // description(openai-completions.ts:309-311),而真工具原先只有 name → 模型看不见说明。
  // 缺省 = 不发(假工具/测试零改动)。
  description?: string;
  // T2 AC-T2-4:旁挂 JSON Schema,loop 在 run 前 ajv 校验(照 pi prepare→validate);
  // 失败 → error toolResult 回喂,不执行 run、不断循环。缺省 = 不校验。
  schema?: object;
  // T2 AC-T2-5/6:声明豁免 beforeToolCall 确认门(= 只读类,read 置 true)。
  // 缺省 false → 新工具自动过安检(story 24,确认逻辑在 loop 不在工具)。
  skipConfirm?: boolean;
  // T2 AC-T2-7:"always" 落盘的规则种子抽取器(工具声明域知识,确认逻辑仍在 loop)。
  // bash 的 `git push` → `git:*`。loop 对同工具的新调用再抽一次,字符串相等 = 免弹。
  // 缺省 = 用 JSON.stringify(args) 整参精确匹配。
  prefixOf?: (args: unknown) => string;
  // Story 16 / T4:loop 把 options.signal 透传给 run,工具(尤其 bash)据此中断/杀进程树。
  // 可选参 → 不观测 signal 的既有工具零改动。
  run(args: unknown, signal?: AbortSignal): Promise<ToolResult>;
}
export interface ToolResult {
  content: TextBlock[];
  isError: boolean;
  // AC-L3-5:某 ToolResult 标 terminate=true → 该批 tool_execution_end 全完后停。
  terminate?: boolean;
}

// ---- AgentEvent 10 类(照抄 pi;agent_end.reason? 为 mini maxTurns 偏离的最小扩)----
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[]; reason?: string }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AssistantMessage }
  | { type: "message_update"; message: AssistantMessage }
  | { type: "message_end"; message: AssistantMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };
