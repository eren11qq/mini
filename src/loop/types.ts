// mini loop 层类型契约(卡 4 / ADR-005 瘦身:stream 词汇 → stream/protocol.ts、tool 词汇 → tools/tool.ts、
// content blocks → src/blocks.ts —— 每缝契约住自己家,新增方言/工具不再触碰本文件)。
// AgentEvent 10 类照抄 pi `packages/agent/src/types.ts:428-443`(实测,非 12)。
import type { ContentBlock, TextBlock } from "../blocks.ts";
import type { Tool } from "../tools/tool.ts";

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

// provider 的 token 计量(usage):adapter 在 done 填、loop 透传给 AssistantMessage。
// 住 loop 因 AssistantMessage 持有它;stream/protocol 反向 import(方向锁见该文件头)。
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

// ---- context / options ----
export interface LoopContext {
  systemPrompt?: string;
  messages: AgentMessage[];
  // 卡 4:逃生舱 unknown[] 敲实为注册表类型 —— cli 不再预映射,方言自从 Tool 映射 wire(单一表示)。
  tools?: Tool[];
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
