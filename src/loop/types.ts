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
  confirm?: (prompt: string) => "yes" | "always" | "no";
  maxTurns?: number;
  clock?: () => number;
}

// ---- provider 事件(流进 runLoop)----
export type ProviderEvent =
  | { type: "start" }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "toolcall_delta"; delta: string }
  | { type: "done"; stopReason: StopReason }
  | { type: "error"; stopReason: "error" | "aborted"; errorMessage?: string };

// ---- streamFn 缝 ----
// 注:(config, context) 形态的 config 绑定留 S1 真 adapter;L1 假流只用 context。
export type StreamFn = (context: LoopContext) => AsyncIterable<ProviderEvent>;

// ---- AgentEvent 10 类(照抄 pi)----
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
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
