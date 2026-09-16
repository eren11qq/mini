// mini loop 层类型契约(卡 4 / ADR-005 瘦身:stream 词汇 → stream/protocol.ts、tool 词汇 → tools/tool.ts、
// content blocks → src/blocks.ts —— 每缝契约住自己家,新增方言/工具不再触碰本文件)。
// AgentEvent 10 类照抄 pi `packages/agent/src/types.ts:428-443`(实测,非 12)。
import type { ContentBlock, TextBlock } from "../blocks.ts";
import type { Tool } from "../tools/tool.ts";
import type { Rule } from "./rules.ts";

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
// C6(docs/ISSUES.md)四档确认答案。reason 仅 no 有意义:进 toolResult 回喂模型,
// 支撑"拒绝带反馈重试"。session = 内存规则(同匹配器同短路点),生命周期 = 调用方持有
// 的 sessionRules 数组,不落盘 → 新进程复弹;"手删即撤销""禁一键全允许"两条不变式不受影响。
export type ConfirmAnswer = {
  kind: "yes" | "session" | "always" | "no";
  reason?: string;
};

export interface RunLoopOptions {
  // H1:裸 readline 的 question 天然异步 → 允许返回 Promise(loop 侧 await;同步实现照旧兼容)。
  confirm?: (prompt: string) => ConfirmAnswer | Promise<ConfirmAnswer>;
  // T2 AC-T2-7/8:rules.json 路径(D4:测试注入临时目录,生产 = <cwd>/rules.json)。
  // 缺省 = 不读写 rules(always 退化为一次性 yes)。
  rulesPath?: string;
  maxTurns?: number;
  clock?: () => number;
  // AC-L3-4:外部 abort。loop 在 for-await 顶 + 工具批前查 .aborted;
  // 命中 → partial.stopReason="aborted" → turn_end + agent_end(reason="aborted")。
  // streamFn 自己是否观测 signal 留 S1 真 adapter(fetch 传 signal);L3 loop 缝内查兜底。
  signal?: AbortSignal;
  // C7(docs/ISSUES.md):--auto-accept-edits。开 → matchKind:"path" 工具且目标在 cwd 内
  // 直通免弹(bash 不受影响;C5 黑名单与 cwd 外照常拦)。缺省 = 现行为零变化。
  autoAcceptEdits?: boolean;
  // C6 AC-1:session 档规则容器。调用方(cli 每进程)持有数组 → 跨多次 runLoop 存活 =
  // "同 run 免弹";换新数组 = 新 run 复弹。loop 只在答 session 时 push,永不写盘。
  // 缺省 = 无 session 档语义(always 落盘路径不受影响)。
  sessionRules?: Rule[];
}

// ---- AgentEvent 10 类(照抄 pi;agent_end.reason? 为 mini maxTurns 偏离的最小扩)----
// D4(docs/ISSUES.md)契约扩,先例 = 上注「maxTurns 唯一故意偏离」同款记法:
// 全 10 类可选 agentId? = 子代理归属。缺省 undefined = 主代理(trace 行零此键 = diff-0 锚);
// 打戳唯一下落 = tools/task.ts 上报处,loop 体零特判(故事 18/23)。
// agent_end.usage? = D4 child usage 合计一行(PRD 风险注「trace 必含」;主代理同样缺省)。
// 交叉落法(单点声明,union 判别窄化不受影响)= D2 卡「cast 届时摘」兑现,trace.ts 已摘。
export type AgentEvent = (
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[]; reason?: string; usage?: Usage }
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
    }
) & { agentId?: string };
